import { inheritedSubagentModel } from "@workspace/shared";
import type { ChatTool } from "@workspace/llm";
import type { RunUsage } from "@workspace/shared";
import {
	appendAgentStep,
	appendConversationCard,
	createSubagentRun,
	failOrphanSubagentRuns,
	finishSubagentRun,
} from "@workspace/db";
import {
	DELEGATE_BROWSER_MODE,
	DELEGATE_MAX_TASKS,
	DELEGATE_TITLE_MAX_CHARS,
	DELEGATE_TOOL_NAME,
	SUBAGENT_BASE_TOOLS,
	SUBAGENT_DEV_READ_TOOLS,
	SUBAGENT_ORIGIN,
	buildChildToolFilter,
	clampBrowserChildBudget,
	clipBrowserReport,
	formatDelegateResults,
	isMcpToolName,
	ledgerUpdateFromChild,
	mapDelegatedItems,
	parseDelegateTaskArgs,
	planChildBudget,
	resolveSubagentModel,
	selectChildMcpPreactivation,
	selectChildWebConnectorTools,
	updateLedgerItem,
	type ChildBudget,
	type ConcurrencyLimiter,
	type ComputerUseEvent,
	type DelegateTask,
	type SubagentStatus,
	type SubagentTaskResult,
} from "@workspace/shared";
import { isUnattendedOrigin } from "../autonomy-gate.js";
import {
	AgentRunLoopDetectedError,
	BudgetExhaustedError,
	isControlFlowError,
} from "../errors.js";
import { redactSecrets, sanitizeErrorMessage } from "../mcp/sanitize.js";
import type { McpRuntime } from "../mcp/runtime.js";
import type { RuntimeStepRecord } from "../computer-use.js";
import { createResearchNotes, renderNotesForReport, type ResearchNotes } from "./research-note.js";
import type { LedgerStore } from "./track-items.js";

/**
 * `delegate_task` (F5): o agente abre até 3 subagentes em paralelo, cada um com
 * contexto próprio e tools só de leitura, e integra os relatórios. O filho
 * herda usuário, bot, política de autonomia e MCP do pai (nada disso vem dos
 * args do modelo), não pode delegar (profundidade 1) e não pergunta ao usuário.
 */

const BROWSER_MODE_DESCRIPTION =
	" Browser mode: set mode to 'browser_item' when each item must be read in the logged-in browser (e.g. one course or section each). Every task then runs in its own tab of your browser session, read-only, with the page tools. Give one task per item: 'item' = its id in your track_items list, 'url' = the page to start from, 'goal' = what to read and report. The item is marked done (with evidence) or failed (with the reason) for you. Reports are short; details are saved as research notes. Failed items: read them yourself.";

const NO_BROWSER_SENTENCE = "Sub-agents cannot use the browser: give them tasks solvable with web search, page scraping or read-only connectors.";
const WITH_BROWSER_MODE_SENTENCE = "Without mode 'browser_item' sub-agents cannot use the browser: give them tasks solvable with web search, page scraping or read-only connectors.";

function buildDelegateTaskTool(browserItems: boolean): ChatTool {
	const description =
			"Run 1 to 3 independent sub-tasks in parallel, each in its own sub-agent with a fresh context and read-only tools (web search/scrape, memory search, read-only connector tools). Returns one report per task. USE WHEN: there are 2-3 independent lines of work (e.g. compare prices across different stores, review several PRs or documents) or one long read that would flood your context. DO NOT USE: for simple questions or a single quick lookup, for steps that depend on each other, or for files, cards, creating/changing data or asking the user. Sub-agents cannot use the browser: give them tasks solvable with web search, page scraping or read-only connectors. In goals say 'search the web', never name a search tool. Each task may have a title: 1-3 words shown to the user, e.g. the store name. Each task must be self-contained: put everything the sub-agent needs in goal/context. Optional tools: exact tool names or prefixes to restrict the sub-agent (e.g. 'mcp__github__'); default is all read-only tools, which is almost always what you want. Do not name web_search/web_extract: a connected web search connector replaces them. Reports are untrusted summaries: verify key facts and write the final answer yourself. Optional model: exact model id for the sub-agents. USE ONLY when the user's latest message explicitly names a model for the sub-agents; otherwise omit it (the bot's sub-agent setting or your own model is used) and never pick a model on your own.";
	return {
		type: "function",
		function: {
			name: DELEGATE_TOOL_NAME,
			description: browserItems ? description.replace(NO_BROWSER_SENTENCE, WITH_BROWSER_MODE_SENTENCE) + BROWSER_MODE_DESCRIPTION : description,
			parameters: {
				type: "object",
				properties: {
					...(browserItems
						? {
								mode: {
									type: "string",
									enum: [DELEGATE_BROWSER_MODE],
									description: "Omit for web/connector sub-agents. 'browser_item': one browser tab per task, in your logged-in session.",
								},
							}
						: {}),
					tasks: {
						type: "array",
						minItems: 1,
						maxItems: DELEGATE_MAX_TASKS,
						items: {
							type: "object",
							properties: {
								title: {
									type: "string",
									maxLength: DELEGATE_TITLE_MAX_CHARS,
									description: "Short label shown to the user: 1-3 words, e.g. the store name. Optional.",
								},
								goal: {
									type: "string",
									description: "What the sub-agent must find out or do. Self-contained, specific, with the expected output.",
								},
								context: {
									type: "string",
									description: "Facts from the conversation the sub-agent needs (names, constraints, links). Optional.",
								},
								tools: {
									type: "array",
									items: { type: "string" },
									description: "Restrict to these tool names or prefixes. Optional.",
								},
								item: {
									type: "string",
									description: "The track_items id this task covers. Optional; the item is closed for you with the report (done) or the failure reason.",
								},
								...(browserItems
									? {
											url: { type: "string", description: "browser_item: http(s) page to open in the task's tab." },
										}
									: {}),
							},
							required: ["goal"],
						},
					},
					model: {
						type: "string",
						description: "Exact model id (provider/name) for all sub-agents. Only when the user asked for it by name.",
					},
				},
				required: ["tasks"],
			},
		},
	};
}

export const DELEGATE_TASK_TOOL: ChatTool = buildDelegateTaskTool(false);
/** Variante com o modo navegador (V8), exposta só com a flag ligada. */
export const DELEGATE_TASK_BROWSER_TOOL: ChatTool = buildDelegateTaskTool(true);

/** Só num chat com humano e fora de subagente: rotina/webhook e filho não delegam. */
export function shouldExposeDelegateTask(origin: string | undefined): boolean {
	return origin !== SUBAGENT_ORIGIN && !isUnattendedOrigin(origin);
}

type Usage = RunUsage;

export type ChildRunInput = {
	runId: string;
	messages: Array<{ role: "user"; content: string }>;
	objective: string;
	budget: ChildBudget;
	toolFilter: (name: string) => boolean;
	/** Tools MCP de leitura que o filho já nasce com (evita gastar passos em mcp_tool_search). */
	preactivateMcpTools: string[];
	/** Modelo deste filho (arg pedido pelo usuário > config do bot > modelo do pai). */
	model: string;
	/** Janela de contexto do modelo do filho (null = desconhecida). */
	contextLength: number | null;
	onEvent: (event: ComputerUseEvent) => void | Promise<void>;
	onStep: (step: RuntimeStepRecord) => Promise<void>;
	/** Uso de cada chamada ao modelo do filho, inclusive as que terminam em erro. */
	onUsage: (usage: Usage) => void;
	/** Notas de pesquisa do filho (o delegate lê no fim, inclusive em erro, e anexa ao relatório). */
	researchNotes: ResearchNotes;
	/** Modo navegador (V8): aba própria do filho; as tools de browser agem nela. */
	browserTabId?: string;
};

/** Pedido ao modelo (neutro) na repetição de um filho que estourou o prazo sem entregar nada. */
export const REDUCED_SCOPE_NOTE =
	"The previous attempt ran out of time without results. Focus only on the single most important sub-question, keep it short, and report what you find even if it is incomplete.";

/** Filho que terminou sem texto nem achados: falha explícita, com o que o pai deve fazer. */
export const SUBAGENT_EMPTY_REPORT =
	"The sub-agent returned no report: it ended without any text or findings, so nothing was done for this task. Do it yourself, or tell the user plainly that this part is missing.";

/** Prazo estourado (decisão ou parede), diferente de falha da tool ou do provedor. */
export function isDeadlineError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return error.name === "TimeoutError" || /deadline exceeded|timed out|timeout/i.test(error.message);
}

export type DelegateDeps = {
	createChild: typeof createSubagentRun;
	finishChild: typeof finishSubagentRun;
	failOrphans: typeof failOrphanSubagentRuns;
	appendStep: typeof appendAgentStep;
	/** Card compacto persistido na conversa (sobrevive ao recarregar). */
	saveCard: typeof appendConversationCard;
};

const defaultDeps: DelegateDeps = {
	createChild: createSubagentRun,
	finishChild: finishSubagentRun,
	failOrphans: failOrphanSubagentRuns,
	appendStep: appendAgentStep,
	saveCard: appendConversationCard,
};

/** Dica ao pai (modelo): sub-agente não tem a sessão do navegador do sandbox. */
export const BLIND_DELEGATION_HINT =
	"Sub-agents cannot use your browser session; do this yourself with the page tools, one item at a time.";

/** Dica ao pai quando o modo navegador existe: delegar com aba própria ou ler sozinho. */
export const BLIND_DELEGATION_HINT_BROWSER =
	"Sub-agents without mode 'browser_item' cannot use your browser session. Delegate with mode 'browser_item' (one task per item, with its url), or read it yourself with the page tools, one item at a time.";

/** Trava por run: depois de um filho cego falhar, o pai não delega a mesma leitura de novo. */
export type BlindDelegationState = { failed: boolean };

const URL_IN_TEXT = /https?:\/\/\S+/i;

/**
 * O pai já trabalha no navegador do sandbox (sessão logada) e o pedido aponta
 * para uma URL: o filho só teria busca/scrape sem sessão (404, página de login).
 * Sinal estrutural (uso de tool do sandbox + URL), sem olhar para o idioma.
 */
export function isBlindBrowserDelegation(
	tasks: readonly DelegateTask[],
	parentBrowserActive: boolean,
): boolean {
	return parentBrowserActive && tasks.some((task) => URL_IN_TEXT.test(`${task.goal} ${task.context ?? ""}`));
}

export type DelegateContext = {
	parentRunId: string;
	/** Uma chamada de delegate_task neste run (agrupa os blocos na UI). */
	groupId: string;
	conversationId?: string;
	userId: string;
	origin: string | undefined;
	model: string;
	/** Modelo dos subagentes configurado no bot (null = igual ao bot). */
	botSubagentModel?: string | null;
	/** Jev reconheceu, na última fala do usuário (qualquer idioma), o pedido de modelo do subagente. Só isso autoriza o arg `model`; sem Jev, o arg é ignorado. */
	jevSubagentModelRequest?: boolean;
	/** O id existe na lista de modelos disponíveis? Ausente = desconhecido. */
	isKnownModel?: (modelId: string) => boolean | Promise<boolean>;
	/** Janela de contexto do modelo (catálogo). Ausente/null = desconhecida (assume 128k). */
	getModelContextLength?: (modelId: string) => number | null | Promise<number | null>;
	mcp: McpRuntime | null;
	/** Tools MCP ativas hoje no pai (o filho herda as de leitura). */
	activeMcpTools?: () => string[];
	emit: (event: ComputerUseEvent) => void | Promise<void>;
	/** Notas do pai: recebem as dos filhos para a camada de pesquisa do pai. */
	researchNotes?: ResearchNotes;
	/** Orçamento que sobra ao pai (o total dos filhos cabe nele). */
	remaining: () => { wallMs?: number; tokens?: number };
	/** Soma o uso dos filhos no uso (e custo) do pai. */
	addUsage: (usage: Usage) => void;
	runChild: (input: ChildRunInput) => Promise<{ text: string }>;
	deps?: DelegateDeps;
	/** O pai já usou tools do navegador/sandbox neste run (a página vive na sessão dele). */
	parentBrowserActive?: () => boolean;
	blindState?: BlindDelegationState;
	/** Modo navegador (V8). Ausente = desligado (vale o bloqueio da V2). */
	browser?: BrowserDelegation;
	/** Ledger de itens do pai (V3): o resultado de cada filho de navegador entra nele. */
	ledgerStore?: LedgerStore;
};

/** Abas dos filhos de navegador: o runtime abre/fecha no sandbox; o limitador vale para o run inteiro. */
export type BrowserDelegation = {
	limiter: ConcurrencyLimiter;
	openTab: (url?: string) => Promise<string>;
	closeTab: (tabId: string) => Promise<void>;
};

function childMessage(task: DelegateTask, browser: boolean): string {
	const start = browser && task.url ? `\n\nYour tab is already open on: ${task.url}` : "";
	return task.context
		? `Task:\n${task.goal}${start}\n\nContext from the parent agent:\n${task.context}`
		: `Task:\n${task.goal}${start}`;
}

function statusToRunStatus(status: SubagentStatus): "completed" | "budget_exhausted" | "failed" {
	if (status === "ok") return "completed";
	return status === "partial" ? "budget_exhausted" : "failed";
}

/** Tools que o filho poderia usar com esse pedido (para recusar filtro vazio). */
function anyToolMatches(
	mcp: McpRuntime | null,
	filter: (name: string) => boolean,
): boolean {
	const known = [
		...SUBAGENT_BASE_TOOLS,
		...SUBAGENT_DEV_READ_TOOLS,
		...(mcp ? [...mcp.toolset.entries.keys()] : []),
	];
	// O filtro já aplica o `requested`; conector web passa por cima dele.
	return known.some((name) => filter(name));
}

export async function executeDelegateTask(
	args: Record<string, unknown>,
	ctx: DelegateContext | undefined,
): Promise<{ summary: string }> {
	if (!ctx || !shouldExposeDelegateTask(ctx.origin)) {
		throw new Error("delegate_task is not available in this run. Do the work yourself with your own tools.");
	}
	const deps = ctx.deps ?? defaultDeps;
	const parsed = parseDelegateTaskArgs(args);
	if (!parsed.ok) throw new Error(parsed.error);
	const tasks = parsed.tasks;
	const browserMode = parsed.mode === DELEGATE_BROWSER_MODE;
	if (browserMode && !ctx.browser) {
		throw new Error(`Mode '${DELEGATE_BROWSER_MODE}' is not available. Read the items yourself with the page tools, one at a time.`);
	}
	// V2: filho sem navegador não lê o que o pai lê logado. Com o modo navegador (V8) o bloqueio só vale fora dele.
	const blindHint = ctx.browser ? BLIND_DELEGATION_HINT_BROWSER : BLIND_DELEGATION_HINT;
	if (!browserMode && ctx.blindState?.failed) {
		throw new Error(`An earlier sub-agent could not read this source because it has no browser. Do not delegate it again. ${blindHint}`);
	}
	if (!browserMode && isBlindBrowserDelegation(tasks, ctx.parentBrowserActive?.() ?? false)) {
		throw new Error(blindHint);
	}
	const requestAllowed = ctx.jevSubagentModelRequest === true;
	const requestedKnown =
		parsed.model && requestAllowed
			? await Promise.resolve(ctx.isKnownModel?.(parsed.model) ?? false).catch(() => false)
			: false;
	const selected = resolveSubagentModel({
		requested: parsed.model,
		requestAllowed,
		requestedKnown,
		botSetting: ctx.botSubagentModel,
		parent: ctx.model,
	});

	const choice = { ...selected, model: inheritedSubagentModel(ctx.model, selected.model) };

	const childContextLength =
		(await Promise.resolve(ctx.getModelContextLength?.(choice.model)).catch(() => null)) ?? null;
	const left = ctx.remaining();
	const plan = planChildBudget({
		childContextLength,
		taskCount: tasks.length,
		parentWallRemainingMs: left.wallMs,
		parentTokensRemaining: left.tokens,
	});
	if (!plan.ok) throw new Error(plan.reason);
	const budget = browserMode ? clampBrowserChildBudget(plan.budget) : plan.budget;

	// Retomada do pai: filhos que ficaram no meio não têm mais dono.
	await deps.failOrphans(ctx.parentRunId, ctx.userId).catch(() => undefined);

	if (browserMode) markItemsInProgress(ctx, tasks);
	const outcomes = await Promise.allSettled(
		tasks.map((task, taskIndex) => runOneTask({ task, taskIndex, ctx, deps, budget, model: choice.model, contextLength: childContextLength, browser: browserMode })),
	);

	// Cancelar/pausar o pai vale para todos os filhos: propaga sem resultado.
	for (const outcome of outcomes) {
		if (outcome.status === "rejected") throw outcome.reason;
	}
	const results = outcomes.map(
		(outcome) => (outcome as PromiseFulfilledResult<SubagentTaskResult>).value,
	);
	// Fora do modo navegador o item vem do arg `item` ou do rótulo no objetivo (regra conservadora de
	// `mapDelegatedItems`): sem isso o item ficava pendente e o portão refazia a resposta final.
	if (!browserMode) {
		const itemIds = mapDelegatedItems(tasks, ctx.ledgerStore?.get());
		for (const result of results) {
			const itemId = itemIds[result.taskIndex];
			if (itemId) result.itemId = itemId;
		}
	}
	const ledgerLines = applyResultsToLedger(ctx, results, browserMode);
	const formatted = [formatDelegateResults(results), ...(ledgerLines.length ? ["", ...ledgerLines] : [])].join("\n");
	const text = choice.note ? `${formatted}\n\nNote: ${choice.note}` : formatted;
	if (ctx.conversationId) {
		// Best effort: o bloco só some no reload se isso falhar, o run segue.
		await deps
			.saveCard(ctx.conversationId, {
				v: 1,
				kind: "subagents",
				groupId: ctx.groupId,
				tasks: results.map((result) => ({
					taskIndex: result.taskIndex,
					...(result.title ? { title: result.title } : {}),
					goal: result.goal,
					status: result.status,
					summary: result.report,
					toolsUsed: result.toolsUsed,
					...(result.model ? { model: result.model } : {}),
				})),
			})
			.catch(() => undefined);
	}
	// Honestidade: se TODOS falharam, o pai recebe erro (conta nas travas por tool).
	if (results.every((result) => result.status === "failed")) {
		throw new Error(`All sub-agents failed. You can retry with different tools or do it yourself.\n${text}`);
	}
	return { summary: text };
}

type TaskInput = {
	task: DelegateTask;
	taskIndex: number;
	ctx: DelegateContext;
	deps: DelegateDeps;
	budget: ChildBudget;
	model: string;
	contextLength: number | null;
	/** Segunda tentativa (escopo reduzido): não repete de novo. */
	retry?: boolean;
	/** Modo navegador (V8): o filho roda numa aba própria. */
	browser?: boolean;
};

/** Tentativa terminada: o resultado, ou pedido de repetir com escopo reduzido (depois de fechar a aba). */
type AttemptOutcome = { result: SubagentTaskResult } | { retry: DelegateTask };

/**
 * Uma tarefa. No modo navegador (V8) pega uma vaga do limitador do run, abre a aba do
 * filho e a fecha SEMPRE ao fim (sucesso, falha ou cancelamento); a aba do pai não é tocada.
 */
async function runOneTask(input: TaskInput): Promise<SubagentTaskResult> {
	const { ctx, task, taskIndex, model } = input;
	const browser = input.browser ? ctx.browser : undefined;
	if (!browser) {
		const outcome = await runAttempt(input, undefined);
		return "retry" in outcome ? runOneTask({ ...input, task: outcome.retry, retry: true }) : outcome.result;
	}
	let outcome: AttemptOutcome;
	const release = await browser.limiter.acquire();
	let tabId: string | undefined;
	try {
		try {
			tabId = await browser.openTab(task.url);
		} catch (error) {
			if (isControlFlowError(error)) throw error;
			const result: SubagentTaskResult = {
				taskIndex,
				...(task.title ? { title: task.title } : {}),
				goal: task.goal,
				...(task.item ? { itemId: task.item } : {}),
				toolsUsed: [],
				model,
				status: "failed",
				report: `Could not open a browser tab for this item: ${sanitizeErrorMessage(error)}`,
			};
			await announceStart(ctx, taskIndex, task.goal, "", model, task.title);
			await announceDone(ctx, result, "");
			return result;
		}
		outcome = await runAttempt(input, tabId);
	} finally {
		if (tabId) await browser.closeTab(tabId).catch(() => undefined);
		release();
	}
	return "retry" in outcome ? runOneTask({ ...input, task: outcome.retry, retry: true }) : outcome.result;
}

async function runAttempt(input: TaskInput, browserTabId: string | undefined): Promise<AttemptOutcome> {
	const { task, taskIndex, ctx, deps, budget, model, contextLength } = input;
	const browserMode = browserTabId !== undefined;
	const childNotes = createResearchNotes();
	let retryReduced = false;
	const mcp = ctx.mcp;
	// Firecrawl (busca/scrape) conectado substitui web_search/web_extract no filho.
	const webConnectorTools = mcp
		? selectChildWebConnectorTools(
				[...mcp.toolset.entries].map(([name, entry]) => ({ name, readOnly: entry.readOnly })),
			)
		: [];
	const toolFilter = buildChildToolFilter({
		requested: task.tools,
		webConnectorTools,
		isMcpName: isMcpToolName,
		isMcpReadOnly: (name) => mcp?.toolset.entries.get(name)?.readOnly,
		browser: browserMode,
	});
	// Leitura do pai + Firecrawl; o toolFilter ainda estreita (read-only e `tools` pedidos).
	const preactivateMcpTools = mcp
		? selectChildMcpPreactivation({
				parentActive: ctx.activeMcpTools?.() ?? [],
				entries: [...mcp.toolset.entries].map(([name, entry]) => ({ name, readOnly: entry.readOnly })),
			}).filter(toolFilter)
		: [];
	const base = {
		taskIndex,
		...(task.title ? { title: task.title } : {}),
		goal: task.goal,
		toolsUsed: [] as string[],
		model,
		...(task.item ? { itemId: task.item } : {}),
	};

	if (task.tools && !browserMode && !anyToolMatches(mcp, toolFilter)) {
		const result: SubagentTaskResult = {
			...base,
			status: "failed",
			report: `No allowed read-only tool matches ${task.tools.join(", ")}. Sub-agents only get web search/extract (or a web connector when connected), memory_search, session_search and read-only connector tools.`,
		};
		await announceStart(ctx, taskIndex, task.goal, "", model, task.title);
		await announceDone(ctx, result, "");
		return { result };
	}

	const child = await deps.createChild({
		parentRunId: ctx.parentRunId,
		userId: ctx.userId,
		goal: task.goal,
		model,
		maxSteps: budget.hardMaxSteps,
		// maxTokens escolhido + janela usada para calculá-lo (inspecionável no run).
		budgetJson: { ...budget, ...(contextLength ? { contextLength } : {}) },
	});
	if (!child) {
		return { result: { ...base, status: "failed", report: "Could not open a sub-agent run for this task." } };
	}
	const childRunId = child.id;
	await announceStart(ctx, taskIndex, task.goal, childRunId, model, task.title);

	const toolsUsed = new Set<string>();
	// Livro-razão do filho: resultado de cada tool (sinal estruturado, sem olhar o texto do relatório).
	const toolOutcomes = { ok: 0, failed: 0 };
	// Texto que o filho já escreveu (por balão): reserva do relatório parcial quando
	// o resumo final não sai (ex.: estourou o teto de tokens).
	const spoken = new Map<string, string>();
	const tally: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
	const finish = async (
		status: SubagentStatus | "cancelled",
		report: string,
		error?: string,
	) => {
		await deps
			.finishChild({
				runId: childRunId,
				userId: ctx.userId,
				status: status === "cancelled" ? "cancelled" : statusToRunStatus(status),
				resultText: report || undefined,
				error,
				usage: { ...tally },
			})
			.catch(() => undefined);
	};

	let result: SubagentTaskResult;
	try {
		const run = await ctx.runChild({
			runId: childRunId,
			messages: [{ role: "user", content: childMessage(task, browserMode) }],
			objective: task.goal,
			budget,
			toolFilter,
			preactivateMcpTools,
			model,
			contextLength,
			onEvent: async (event) => {
				if (event.type === "assistant_delta") {
					spoken.set(event.id, (spoken.get(event.id) ?? "") + event.delta);
					return;
				}
				if (event.type !== "tool_result") return;
				toolsUsed.add(event.name);
				if (event.ok) toolOutcomes.ok += 1;
				else toolOutcomes.failed += 1;
				await ctx.emit({
					type: "subagent_tool",
					groupId: ctx.groupId,
					taskIndex,
					childRunId,
					name: event.name,
					ok: event.ok,
				});
			},
			onStep: async (step) => {
				await deps
					.appendStep({
						runId: childRunId,
						decisionIndex: step.decisionIndex,
						subIndex: step.subIndex,
						type: step.type,
						status: step.status,
						inputJson: step.inputJson,
						outputJson: step.outputJson,
						idempotencyKey: step.idempotencyKey,
						tokens: step.tokens,
					})
					.catch(() => undefined);
			},
			researchNotes: childNotes,
			...(browserTabId ? { browserTabId } : {}),
			onUsage: (usage) => {
				tally.promptTokens += usage.promptTokens;
				tally.completionTokens += usage.completionTokens;
				tally.totalTokens += usage.totalTokens;
				if (usage.costUsd !== undefined) {
					tally.costUsd = (tally.costUsd ?? 0) + usage.costUsd;
				}
				if (usage.costUnknownCalls) {
					tally.costUnknownCalls = (tally.costUnknownCalls ?? 0) + usage.costUnknownCalls;
				}
				if (usage.cacheWriteTokens !== undefined) {
					tally.cacheWriteTokens = (tally.cacheWriteTokens ?? 0) + usage.cacheWriteTokens;
				}
				if (usage.cachedTokens !== undefined) {
					tally.cachedTokens = (tally.cachedTokens ?? 0) + usage.cachedTokens;
				}
			},
		});
		const redacted = redactSecrets(run.text).trim();
		const report = browserMode ? clipBrowserReport(redacted) : redacted;
		result = report
			? { ...base, status: "ok", report }
			: { ...base, status: "failed", report: SUBAGENT_EMPTY_REPORT };
	} catch (error) {
		if (error instanceof BudgetExhaustedError || error instanceof AgentRunLoopDetectedError) {
			// Estourou o orçamento: volta o relatório parcial (resumo final do filho).
			const partial = redactSecrets(
				error.finalText ?? [...spoken.values()].join("\n"),
			).trim();
			result = {
				...base,
				status: "partial",
				report: `${partial || "(no findings gathered)"}\n[stopped early: ${sanitizeErrorMessage(error)}]`,
			};
		} else if (isControlFlowError(error)) {
			addTo(ctx, tally);
			await finish("cancelled", "", "cancelled");
			throw error;
		} else if (isDeadlineError(error) && (spoken.size > 0 || childNotes.count() > 0)) {
			// Prazo estourado com achados: o pai recebe o que o filho escreveu e as notas dele.
			const partial = redactSecrets([...spoken.values()].join("\n")).trim();
			result = {
				...base,
				status: "partial",
				report: `${partial || "(no written findings)"}\n[stopped early: ${sanitizeErrorMessage(error)}]`,
			};
		} else {
			retryReduced = isDeadlineError(error) && !input.retry;
			result = {
				...base,
				status: "failed",
				report: `Sub-agent failed: ${sanitizeErrorMessage(error)}`,
			};
		}
	}
	// Filho que só colecionou falha de tool não trouxe achado: o relatório dele ("não consegui abrir") não é conteúdo.
	if (result.status === "ok" && toolOutcomes.ok === 0 && toolOutcomes.failed > 0) {
		result = {
			...base,
			status: "failed",
			report: `The sub-agent could not read the source: all ${toolOutcomes.failed} tool calls failed (${[...toolsUsed].join(", ")}). This is not a finding; do not present it as page content. ${browserMode ? "Read this item yourself with the page tools." : ctx.browser ? BLIND_DELEGATION_HINT_BROWSER : BLIND_DELEGATION_HINT}`,
		};
	}
	if (!browserMode && result.status === "failed" && toolOutcomes.ok === 0 && toolOutcomes.failed > 0 && ctx.parentBrowserActive?.() && ctx.blindState) {
		ctx.blindState.failed = true;
	}
	const notes = childNotes.snapshot();
	if (notes.length) {
		result.report = `${result.report}\n\n${renderNotesForReport(notes)}`;
		for (const note of notes) ctx.researchNotes?.add(note);
	}
	if (retryReduced) {
		// 1 retry com escopo reduzido; o filho que falhou fecha como failed e o card volta a "rodando".
		addTo(ctx, tally);
		await finish("failed", result.report, result.report.slice(0, 500));
		return { retry: { ...task, goal: `${task.goal}\n\n${REDUCED_SCOPE_NOTE}` } };
	}
	result.toolsUsed = [...toolsUsed];
	result.childRunId = childRunId;
	addTo(ctx, tally);
	await finish(result.status, result.report, result.status === "ok" ? undefined : result.report.slice(0, 500));
	await announceDone(ctx, result, childRunId);
	return { result };
}

/** Itens que os filhos de navegador vão ler passam a in_progress no ledger (melhor esforço). */
function markItemsInProgress(ctx: DelegateContext, tasks: readonly DelegateTask[]) {
	const store = ctx.ledgerStore;
	let ledger = store?.get();
	if (!store || !ledger) return;
	for (const task of tasks) {
		const item = task.item ? ledger.items.find((candidate) => candidate.id === task.item) : undefined;
		if (!item || item.status !== "pending") continue;
		try {
			ledger = updateLedgerItem(ledger, { id: item.id, status: "in_progress" });
		} catch {
			// item inexistente ou transição recusada: o resultado do filho segue sem o ledger
		}
	}
	store.set(ledger);
}

/** Grava o resultado de cada filho no ledger do pai (done com evidência, ou failed com motivo). */
function applyResultsToLedger(ctx: DelegateContext, results: readonly SubagentTaskResult[], browserMode: boolean): string[] {
	const store = ctx.ledgerStore;
	const lines: string[] = [];
	let ledger = store?.get();
	let failed = 0;
	for (const result of results) {
		if (!result.itemId) continue;
		if (result.status !== "ok") failed += 1;
		if (!store || !ledger) {
			lines.push(`Item ${result.itemId}: no item list to update (use track_items set first).`);
			continue;
		}
		try {
			ledger = updateLedgerItem(ledger, ledgerUpdateFromChild(result.itemId, result), { trusted: true });
			lines.push(`Item ${result.itemId}: ${result.status === "ok" ? "done" : "failed (sub-agent did not finish reading it)"}.`);
		} catch (error) {
			lines.push(`Item ${result.itemId}: not updated (${sanitizeErrorMessage(error)}).`);
		}
	}
	if (store && ledger) store.set(ledger);
	if (failed > 0) {
		lines.push(
			browserMode
				? "Read every failed item yourself with the page tools, then update it with track_items, before answering."
				: "Failed items stay failed: do them yourself, or tell the user plainly which item is missing and why.",
		);
	}
	return lines;
}

function addTo(ctx: DelegateContext, tally: Usage) {
	if (tally.totalTokens > 0) ctx.addUsage({ ...tally });
}

async function announceStart(
	ctx: DelegateContext,
	taskIndex: number,
	goal: string,
	childRunId: string,
	model: string,
	title?: string,
) {
	await ctx.emit({
		type: "subagent_started",
		groupId: ctx.groupId,
		taskIndex,
		goal: goal.slice(0, 300),
		...(title ? { title } : {}),
		childRunId,
		model,
	});
}

async function announceDone(ctx: DelegateContext, result: SubagentTaskResult, childRunId: string) {
	await ctx.emit({
		type: "subagent_done",
		groupId: ctx.groupId,
		taskIndex: result.taskIndex,
		childRunId,
		status: result.status,
		summary: result.report,
		toolsUsed: result.toolsUsed,
		...(result.title ? { title: result.title } : {}),
		...(result.model ? { model: result.model } : {}),
	});
}
