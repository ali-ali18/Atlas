/**
 * Motor v2 (ADR 0002, F2): um laço simples ao lado do `runComputerUse`, ligado por bot (`policyJson.engine = "v2"`).
 *
 * monta mensagens -> chama o modelo com as tools do registro -> executa as tool calls -> repete até o modelo
 * responder sem tools. Quem decide parar é o Supervisor (orçamento em US$ e tempo, ver `supervisor.ts`); a lista de
 * tarefas é obrigatória em trabalho longo (`task-list.ts`). O contrato de entrada/saída é o do v1
 * (`ComputerUseParams` -> `RunComputerUseResult`), então o worker troca de motor sem mudar o resto.
 *
 * As tools são as mesmas do v1: executam por `executeTool` (cofre, confirmações, cards) com um `ToolContext`
 * montado aqui. O que o v1 faz e o v2 ainda não: ver a seção "Limites desta fase" em docs/features/motor-v2.md.
 */
import { createReasoningEffortPicker } from "../reasoning-effort.js";
import { createHash, randomBytes } from "node:crypto";
import {
	type ChatTool,
	type CompleteChatWithToolsResult,
	type LlmContentPart,
	type LlmMessage,
	type LlmToolCall,
	streamChatWithTools,
} from "@workspace/llm";
import {
	type BotLanguage,
	type ComputerUseEvent,
	type RunStop,
	type TaskListItem,
	DEFAULT_AUTONOMY_LEVEL,
	type EffectiveAutonomy,
	allLanguageInstructions,
	buildPersonaBlock,
	buildToolResultStatus,
	classifyFinish,
	decideAction,
	formatOpenBotRequests,
	isMcpToolName,
	isUntrustedContentTool,
	languageInstruction,
	parseQuestionnaireAnsweredContent,
	parseTaskList,
	renderTaskListNote,
	resolveReplyLanguage,
	SUBAGENT_ORIGIN,
	TRANSCRIPT_SLOT,
	createNotebook,
	type NotebookWriter,
	type RunUsage,
} from "@workspace/shared";
import {
	getBotProfile,
	getConversationUntrustedAt,
	markConversationUntrusted,
	markMcpTaskGrantsUntrusted,
	listSubagentRuns,
	persistConversationCardFromEvent,
	upsertTaskListCard,
} from "@workspace/db";
import { loadSandboxConfig, runSandboxOperation, type SandboxExecutionContext } from "@workspace/sandbox";
import { addUsage, emptyUsage, resolveBudget, wallClockAnchors, type TokenUsage } from "../budget.js";
import {
	buildRuntimeCheckpoint,
	completedToolCallIds,
	createMediaMemo,
	hydrateLlmMessages,
	parseRuntimeCheckpoint,
	resolveLlmMessagesForModel,
	toolIdempotencyKey,
} from "../checkpoint.js";
import {
	OFFERED_TOOLS_SUB_INDEX,
	budgetStopFallbackText,
	connectorsPrompt,
	lastUserPlainText,
	parseArgs,
	recentAssistantPlainTexts,
	recentUserPlainTexts,
	sanitizeAssistantText,
	unavailableToolMessage,
	type ComputerUseParams,
	type RunComputerUseResult,
} from "../computer-use.js";
import { todayNote } from "../context/today-note.js";
import { contextBudgetFor } from "../context/budget.js";
import { namespaceToolCallId, renameProviderItemCallIds } from "../context/transcript.js";
import { STUB_LAST_GROUP_MAX_CHARS, applyPromptHygiene } from "../hygiene.js";
import { toolsJsonCharsOf } from "../tools-json-size.js";
import { modelStepTelemetry } from "../telemetry/step-telemetry.js";
import { isUnattendedOrigin } from "../autonomy-gate.js";
import {
	AgentRunCancelledError,
	AgentRunPausedError,
	errorFromAbortSignal,
	isControlFlowError,
} from "../errors.js";
import { INTERRUPTED_WRITE_NOTE, ToolEffectUncertainError, hashEffectArgs, isJournaledWrite } from "../execution/journal.js";
import { EMPTY_REPLY_FALLBACK_TEXT, EMPTY_REPLY_NOTE, TRUNCATED_REPLY_NOTE, createTaskTracker } from "../execution/task-state.js";
import { appendToLatestToolResult } from "../loop/tool-result-notes.js";
import { swapLanguageInstruction } from "../loop/prompt-builder.js";
import { isBotConfigEventObjective } from "../tools/registry/helpers.js";
import { toolArgsKey, toolResultKey } from "../progress.js";
import { MAX_PARALLEL_READS } from "../read-execution.js";
import { modelUsage } from "../telemetry/model-usage.js";
import { createSecretSession, type SecretSession } from "../secrets/session.js";
import { createProviderHealth } from "../tools/provider-health.js";
import { withAgentPointer } from "../tools/agent-pointer.js";
import { executeTool } from "../tools/registry/execute.js";
import { getToolRegistration } from "../tools/registry/index.js";
import { isSandboxTool } from "../tools/registry/sandbox-tools.js";
import type { ToolContext } from "../tools/registry/types.js";
import type { TaskListStore } from "../tools/task-list.js";
import { classifyToolFailure, withArgumentErrorHint } from "../tool-failure.js";
import { buildEngineV2Catalog } from "./catalog.js";
import { shouldExposeSetEngine } from "../tools/set-engine.js";
import { buildEngineV2SystemPrompt } from "./prompt.js";
import { MAX_STEPS_SAFETY, type SupervisorProfile, budgetForProfile, createSupervisor, deliveryInstruction } from "./supervisor.js";
import { callCostUsd, estimateCostUsd, fallbackPricesFromEnv } from "./cost.js";
import { dedupeLoginAsk, unattendedLoginOutcome } from "./login.js";
import { createPreToolRunner } from "../hooks/pre-tool-runner.js";
import { appendUnconfirmed, createTaskListGate, droppedItems, openItems } from "./task-list.js";
import { type DelegateDeps } from "../tools/delegate-task.js";
import { HELPER_DELIVERY_INSTRUCTION, type HelperChildInput, type HelpersContext } from "./helpers.js";
import { DOCUMENT_DELIVERY_NOTE, DOC_MAX_OUTPUT_TOKENS, countWords, needsDocumentDelivery, withNotebookAppendix } from "./delivery.js";
import { type NotebookToolContext } from "./notebook.js";

export type EngineV2Options = {
	profile: SupervisorProfile;
	/** Ajuste do bot para o trabalho longo (`policyJson.longWorkBudgetUsd` / `longWorkMinutes`). */
	longWorkBudgetUsd?: number;
	longWorkMinutes?: number;
	/** Coordenador em trabalho longo: ajudantes (`policyJson.helperModel` / `helperMaxParallel`; `deps` injeta a persistência em teste). */
	helpers?: {
		model?: string | null;
		maxParallel?: number;
		deps?: DelegateDeps;
		/** Filhos do run (retomada: custo e tarefas já feitas). Padrão: banco, escopado pelo dono. */
		listChildren?: (parentRunId: string, userId: string) => Promise<Array<{ id: string; objective: string; status: string; usageJson: unknown; finishedAt: Date | null }>>;
	};
	/** Máximo de tokens de saída do modelo no catálogo (null = não sabe). Limita o teto do documento. */
	modelMaxOutputTokens?: (modelId: string) => number | null | Promise<number | null>;
	/**
	 * Este run É um ajudante (filho do coordenador): orçamento próprio (fatia do pai), só tools de leitura
	 * (`params.toolFilter` é obrigatório), escreve no caderno do pai e nunca pergunta ao usuário.
	 */
	helper?: { writer: NotebookWriter; budget: { costUsd: number; activeMs: number; maxSteps: number }; preactivateMcpTools?: readonly string[] };
};

const CLOSING_CALL_TIMEOUT_MS = 60_000;
/** Mensagem de runtime que não foi escrita pelo usuário (o modelo não a responde como se fosse dele). */
const AUTO_CONTEXT = "[auto-context, not written by the user]";

type AwaitingKind = "confirm" | "skill_card" | "questionnaire" | "profile";

type CallOutcome = {
	call: LlmToolCall;
	name: string;
	ok: boolean;
	summary: string;
	args: Record<string, unknown>;
	/** Bloqueada pelo Supervisor: não conta para travamento. */
	blocked?: boolean;
	/** A chamada não rodou porque o run vai esperar o usuário. */
	skipped?: boolean;
};

export async function runEngineV2(params: ComputerUseParams, options: EngineV2Options): Promise<RunComputerUseResult> {
	const onEvent = params.onEvent;
	const runId = params.runId ?? "local";
	const userId = params.userId ?? "default";
	const botId = params.botId;
	const conversationId = params.conversationId;
	const origin = params.origin ?? "chat";
	const apiKey = params.apiKey;
	const streamChat = params.streamChat ?? streamChatWithTools;
	const pickReasoningEffort = createReasoningEffortPicker({ effort: params.reasoningEffort, supportsReasoning: params.modelSupportsReasoning });
	const parsed = parseRuntimeCheckpoint(params.restoredCheckpoint);
	let model = params.model;
	let lastModel = params.model;
	const contextLength = params.contextLength;
	const sandboxEnabled = (params.sandboxEnabled ?? true) && loadSandboxConfig().enabled;

	// --- orçamento e relógio (só tempo ATIVO: pausa e fila não contam) ---
	// Tetos do run/conta (custo, tempo e passos) valem sempre: o perfil nunca os ultrapassa.
	const runLimits = resolveBudget({ maxSteps: params.maxSteps, policy: params.budget });
	const helperRole = options.helper;
	if (helperRole && !params.toolFilter) throw new Error("engine v2 helper needs a toolFilter (read-only tools)");
	// Ajudante: o orçamento é a fatia que o coordenador reservou (nunca o perfil do bot).
	const budget = helperRole
		? { maxCostUsd: helperRole.budget.costUsd, maxActiveMs: helperRole.budget.activeMs }
		: budgetForProfile(options.profile, {
				longWorkBudgetUsd: options.longWorkBudgetUsd,
				longWorkMinutes: options.longWorkMinutes,
				accountCapUsd: params.budget?.maxCostUsd,
				accountCapMs: runLimits.maxWallMs,
			});
	const supervisor = createSupervisor({
		profile: options.profile,
		budget,
		maxSteps: Math.min(MAX_STEPS_SAFETY, runLimits.hardMaxSteps, helperRole?.budget.maxSteps ?? MAX_STEPS_SAFETY),
	});
	const wall = wallClockAnchors({ maxWallMs: budget.maxActiveMs, now: Date.now(), runStartedAt: params.runStartedAt, restored: parsed });
	const activeElapsedMs = () => wall.baseMs + (Date.now() - wall.executionStartMs);
	// Folga de 25% sobre o orçamento de tempo só para as operações do computador não ficarem presas para sempre.
	const deadlineAtMs = wall.executionStartMs + Math.round(Math.max(0, budget.maxActiveMs - wall.baseMs) * 1.25);
	const executionContext = { signal: params.abortSignal, deadlineAtMs, ...(params.browserTabId ? { tabId: params.browserTabId } : {}) };
	const manager = withAgentPointer(params.manager.withExecutionContext?.(executionContext) ?? params.manager, (event) => onEvent(event));
	const getSessionId = (context: SandboxExecutionContext = executionContext) =>
		runSandboxOperation(context, 180_000, (signal) => params.getSessionId({ ...context, signal }));

	let usageTotals: TokenUsage = parsed?.usageTotals ? { ...emptyUsage(), ...parsed.usageTotals } : emptyUsage();
	// Chamadas cujo custo o provedor não informou entram no orçamento por estimativa (ver `cost.ts`).
	const fallbackPrices = fallbackPricesFromEnv();
	let estimatedCostUsd =
		usageTotals.costUsd === undefined && (usageTotals.costUnknownCalls ?? 0) > 0 ? estimateCostUsd(usageTotals, fallbackPrices) : 0;
	const spentUsd = () => (usageTotals.costUsd ?? 0) + estimatedCostUsd;
	const toolCallCounts = new Map<string, number>(Object.entries(parsed?.toolCallCounts ?? {}));
	let step = parsed?.nextStepIndex ?? 0;
	const consumedInputIds = new Set<string>(parsed?.consumedInputIds ?? []);
	const loginAsked = new Set(parsed?.loginAsked ?? []);
	let pendingLogin = parsed?.pendingLogin;

	const ensureContinue = async (signal: AbortSignal | undefined = params.abortSignal) => {
		if (signal?.aborted) throw errorFromAbortSignal(signal);
		if (params.shouldContinue && !(await params.shouldContinue())) throw new AgentRunCancelledError();
	};
	const ensureNotPaused = async () => {
		if (params.shouldPause && (await params.shouldPause())) throw new AgentRunPausedError();
	};

	// --- contexto do usuário ---
	const lastUserMessage = [...params.messages].reverse().find((message) => message.role === "user")?.content ?? "";
	const humanTurn =
		params.humanTurn === true &&
		!isBotConfigEventObjective(params.objective ?? "") &&
		!isBotConfigEventObjective(lastUserMessage) &&
		!parseQuestionnaireAnsweredContent(lastUserMessage);
	const botProfile = botId && !helperRole ? await (params.loadBotProfile ?? getBotProfile)(botId, params.userId).catch(() => null) : null;
	// Perfil do bot só muda no chat (onboarding ou pedido explícito): rotina e bot→bot nunca expõem a tool.
	const allowProfileUpdate =
		!helperRole &&
		origin === "chat" &&
		(!botProfile?.description?.trim() ||
		isBotConfigEventObjective(params.objective ?? "") ||
		isBotConfigEventObjective(lastUserMessage) ||
		parseQuestionnaireAnsweredContent(lastUserMessage)?.purpose === "onboarding");
	const replyLanguage = resolveReplyLanguage({ setting: params.language ?? "pt-BR", ...params.languageContext, hasUserMessage: origin === "chat" });
	const language: BotLanguage = replyLanguage.language;
	const languageAtEnd = params.language === "auto";
	const canSeeImages = params.canSeeUserImages !== false;

	let autonomyPolicy: EffectiveAutonomy = params.autonomy ?? { level: DEFAULT_AUTONOMY_LEVEL, exceptions: [] };
	const autonomyHandle = { get: () => autonomyPolicy, set: (next: EffectiveAutonomy) => { autonomyPolicy = next; } };

	// Conversa entre bots: mesma condição do v1 (2+ bots do dono; falha ao listar nunca derruba o run; grupo não injeta o roster).
	const botCount =
		params.listBotRoster && !helperRole && botId && userId !== "default" && (origin === "chat" || origin === "bot")
			? (await params.listBotRoster(userId).catch(() => [])).length
			: 0;

	// --- catálogo de tools ---
	const mcp = params.mcp ?? null;
	const imageIds = params.userImageArtifactIds ?? parsed?.userImageArtifactIds ?? [];
	const catalog = buildEngineV2Catalog({
		origin,
		userId,
		sandboxEnabled,
		autonomy: autonomyPolicy,
		toolFilter: params.toolFilter,
		mcp,
		apiConnector: Boolean(params.apiConnector),
		email: params.email,
		attachments: { present: params.attachments?.present === true },
		planMode: params.planMode,
		allowProfileUpdate,
		hasImageAttachments: imageIds.length > 0,
		routerMessages: params.messages,
		lastUserMessage,
		objective: params.objective,
		priorLoadedTools: params.priorLoadedTools ?? parsed?.loadedTools,
		longWork: options.profile === "long_work" && !helperRole,
		helper: Boolean(helperRole),
		helpers: userId !== "default" && origin === "chat",
		setEngine: !helperRole && shouldExposeSetEngine({ origin, humanTurn, lastUserMessage }),
		botMessaging: { botCount, decideForOtherBots: params.decideForOtherBots === true },
		...(origin === "routine" && params.routinePageId ? { routinePageId: params.routinePageId } : {}),
	});
	if (helperRole?.preactivateMcpTools?.length) catalog.activateMcpTools([...helperRole.preactivateMcpTools]);
	const tools = catalog.tools;
	const hasToolInRun = (name: string) => tools.some((tool) => tool.function.name === name) || Boolean(catalog.deferral?.isDeferred(name));

	// --- lista de tarefas (a mesma do v1: TaskTracker + cartão da doca) ---
	const taskTracker = createTaskTracker(parsed?.taskState, params.objective ?? lastUserMessage);
	if (!parsed?.taskState) taskTracker.setTaskList(parseTaskList(params.priorTaskList));
	const taskListStore: TaskListStore = { get: () => taskTracker.taskList(), set: (next) => taskTracker.setTaskList(next) };
	/** Última lista que o modelo enviou (a do tracker some quando tudo conclui; o portão e os descartados precisam dela). */
	let lastTaskItems: TaskListItem[] | undefined = taskTracker.taskList();
	const emitTaskListEvent = async (items: Array<{ content: string; status: "pending" | "in_progress" | "completed" }>) => {
		lastTaskItems = items.length > 0 ? items : undefined;
		await upsertTaskListCard(conversationId, runId, items).catch(() => undefined);
		await onEvent({ type: "task_list", items, ...(params.runId ? { runId: params.runId } : {}) });
	};
	const taskGate = createTaskListGate({ required: options.profile === "long_work" && !helperRole && hasToolInRun("update_task_list") });

	// --- caderno da tarefa (trabalho longo): só o coordenador o tem; o ajudante escreve no do pai ---
	const longWorkCoordinator = options.profile === "long_work" && !helperRole;
	const notebook = longWorkCoordinator && hasToolInRun("notebook_write") ? createNotebook(parsed?.notebook) : null;
	const notebookTools: NotebookToolContext | undefined = notebook
		? { writer: notebook.writer("coordinator"), reader: notebook }
		: helperRole
			? { writer: helperRole.writer }
			: undefined;
	/** Passo em que o portão do documento já agiu (no máximo uma vez por run) e se algum arquivo já saiu. */
	let documentGateFired = false;
	let fileDelivered = (parsed?.toolCallCounts?.create_file ?? 0) > 0;
	/** Texto que o portão do documento retirou do chat: volta se o run terminar sem arquivo. */
	let gatedText: string | undefined;
	/** Arquivo em partes em andamento (nome -> conteúdo das partes anteriores): o apêndice confere o arquivo inteiro. */
	const filePartsSoFar = new Map<string, string>();
	/** Ajudantes cujo uso já está em `usageTotals` (checkpoint e retomada não contam duas vezes). */
	const accountedHelpers = new Set<string>(parsed?.helperRuns ?? []);
	const currentTaskItems = (): TaskListItem[] | undefined => taskTracker.taskList() ?? lastTaskItems;

	// --- cofre, confiança e integrações ---
	const secretSession: SecretSession | undefined = params.userId
		? createSecretSession({ userId: params.userId, by: () => ({ actor: "bot", botId, conversationId }) })
		: undefined;
	const providerHealth = params.providerHealth ?? createProviderHealth();
	// Hooks antes de cada tool: lições do usuário (confirm_always, required_args, require_prior_call) e plano pendente.
	const preTools = createPreToolRunner({
		lessons: params.lessons?.items,
		preToolRules: params.preToolRules,
		planPending: Boolean(params.planPending),
		toolset: mcp?.toolset,
		loadedToolNames: () => tools.map((tool) => tool.function.name),
		onInspect: params.onInspect,
		recordFeedback: params.lessons?.recordFeedback,
	});
	// "Já pedi login neste site" por conversa (30 min), lido só quando aparece uma tela de login.
	const recentLoginAsks = { asked: new Set<string>(), loaded: false };
	const loadRecentLoginAsks = async () => {
		if (recentLoginAsks.loaded) return recentLoginAsks;
		recentLoginAsks.loaded = true;
		if (userId === "default" || !params.recentLoginAsks) return recentLoginAsks;
		const recent = await params.recentLoginAsks().catch(() => null);
		for (const site of recent?.asked ?? []) recentLoginAsks.asked.add(site);
		return recentLoginAsks;
	};
	let conversationUntrustedRead: Promise<boolean> | undefined;
	const conversationUntrusted = () =>
		(conversationUntrustedRead ??= userId && conversationId
			? getConversationUntrustedAt({ userId, conversationId }).then((at) => at !== null, () => true)
			: Promise.resolve(false));
	const mcpRun = { untrustedSeen: parsed?.untrustedSeen === true, executed: [] as string[], conversationUntrusted };
	let grantsMarkedUntrusted = false;
	const markUntrusted = async () => {
		mcpRun.untrustedSeen = true;
		if (grantsMarkedUntrusted || !userId || !conversationId) return;
		grantsMarkedUntrusted = true;
		await Promise.all([
			markConversationUntrusted({ userId, conversationId }),
			markMcpTaskGrantsUntrusted({ userId, conversationId }),
		]).catch(() => { grantsMarkedUntrusted = false; });
	};
	let shownImageCount = parsed?.shownImageCount ?? 0;
	let generatedImageCount = parsed?.generatedImageCount ?? 0;
	const imageModel = params.imageModel ?? process.env.ATLAS_IMAGE_MODEL?.trim();
	const configuredImageLimit = Number(process.env.ATLAS_IMAGE_MAX_PER_RUN);
	const maxGeneratedImages = Number.isInteger(configuredImageLimit) && configuredImageLimit > 0 ? Math.min(configuredImageLimit, 10) : 3;

	// --- conversa inicial ---
	const turnId = `t${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
	const priorHistory = params.priorTranscript?.length ? await hydrateLlmMessages(params.priorTranscript) : [];
	const placeTranscript = <T extends { role: string; content: unknown }>(list: T[]): LlmMessage[] => {
		const slot = list.findIndex((message) => message.role === "system" && message.content === TRANSCRIPT_SLOT);
		if (slot < 0) return list as unknown as LlmMessage[];
		return [...(list.slice(0, slot) as unknown as LlmMessage[]), ...priorHistory, ...(list.slice(slot + 1) as unknown as LlmMessage[])];
	};
	let conversation: LlmMessage[];
	if (parsed?.llmMessages?.length) {
		conversation = await hydrateLlmMessages(parsed.llmMessages);
		const system = conversation.find((message) => message.role === "system");
		if (system) system.content = swapLanguageInstruction(typeof system.content === "string" ? system.content : "", allLanguageInstructions(), replyLanguage.instruction);
		else conversation.unshift({ role: "system", content: replyLanguage.instruction });
	} else {
		const systemPrompt = buildEngineV2SystemPrompt({
			persona: buildPersonaBlock({ name: botProfile?.name, role: botProfile?.description, language: params.language ?? "pt-BR" }),
			profile: options.profile,
			model,
			connectors: mcp && mcp.toolset.entries.size > 0 ? `\n\n${connectorsPrompt(mcp.toolset)}` : "",
			skillIndex: params.skillIndex,
			toolIndex: catalog.index,
			preloadedGroups: catalog.preloaded,
			atlasUrl: process.env.ATLAS_URL,
			helpers: hasToolInRun("delegate"),
			taskList: hasToolInRun("update_task_list"),
			role: helperRole ? "helper" : undefined,
			...(isUnattendedOrigin(origin) && !helperRole ? { unattended: true } : {}),
			...(origin === "routine" && !helperRole ? { routine: true } : {}),
			// Só se a caixa estiver ativa neste run: sem `email_reply` o prompt mandaria usar uma tool inexistente.
			...(origin === "email" && !helperRole && hasToolInRun("email_reply") ? { emailRun: true } : {}),
			languageInstruction: languageAtEnd ? replyLanguage.instruction : undefined,
		});
		conversation = [
			{ role: "system", content: systemPrompt },
			...placeTranscript(params.messages.map((message) => ({ role: message.role, content: message.content }))),
		];
		// Pedidos a outros bots sem resposta (mesmo bloco do v1; vazio não custa nada): o modelo não os apresenta como prontos.
		const openBotRequests = !helperRole ? formatOpenBotRequests(params.openBotRequests ?? [], new Date()) : null;
		if (openBotRequests) conversation.push({ role: "system", content: openBotRequests });
		const lastUser = [...conversation].reverse().find((message) => message.role === "user");
		if (lastUser && imageIds.length > 0) {
			lastUser.content = [
				{ type: "text", text: typeof lastUser.content === "string" ? lastUser.content : "" },
				...imageIds.slice(0, 4).map((artifactId) => ({ type: "image_ref" as const, artifactId })),
			];
		}
		if (lastUser && params.attachments?.turnContext) {
			const existing: LlmContentPart[] = typeof lastUser.content === "string" ? [{ type: "text", text: lastUser.content }] : Array.isArray(lastUser.content) ? lastUser.content : [];
			lastUser.content = [
				...existing,
				{ type: "text", text: params.attachments.turnContext },
				...(params.attachments.nativePdfs ?? []).map((pdf) => ({ type: "file_ref" as const, artifactId: pdf.id, filename: pdf.filename })),
			];
		}
	}

	// --- checkpoint ---
	let checkpointTail: Promise<void> = Promise.resolve();
	const snapshotCheckpoint = (stepIndex: number) =>
		buildRuntimeCheckpoint({
			messages: params.messages,
			conversation,
			userImageArtifactIds: imageIds,
			generatedImageCount,
			shownImageCount,
			nextStepIndex: stepIndex,
			model: lastModel,
			consumedInputIds: [...consumedInputIds],
			usageTotals,
			toolCallCounts: Object.fromEntries(toolCallCounts),
			loginAsked: [...loginAsked],
			untrustedSeen: mcpRun.untrustedSeen,
			pendingLogin,
			taskState: taskTracker.persistable(),
			notebook: notebook?.snapshot(),
			helperRuns: [...accountedHelpers],
			activeElapsedMs: activeElapsedMs(),
			loadedTools: [...catalog.activeMcpTools(), ...tools.map((tool) => tool.function.name).filter((name) => !isMcpToolName(name))],
			transcriptWatermark: parsed?.transcriptWatermark ?? params.transcriptWatermark,
			carriedNotes: parsed?.carriedNotes ?? params.carriedNotes,
			recoveries: parsed?.recoveries,
			recoveredAtStep: parsed?.recoveredAtStep,
		});
	const persistCheckpoint = (stepIndex: number) => {
		if (!params.onCheckpoint) return Promise.resolve();
		const snapshot = snapshotCheckpoint(stepIndex);
		const write = checkpointTail.then(() => params.onCheckpoint!(snapshot));
		checkpointTail = write.catch(() => undefined);
		return write;
	};

	// --- retomada depois do login ---
	if (pendingLogin) {
		const resumed = pendingLogin;
		pendingLogin = undefined;
		const captcha = resumed.reason === "captcha";
		conversation.push({
			role: "user",
			content: captcha
				? `[captcha-complete] The user says they solved the verification on ${resumed.site}. Your next action must be browser_snapshot to re-read the page, then continue the task from where you stopped. If the captcha is still there, do not ask again: use another source or report it.`
				: `[login-complete] The user says they finished logging in to ${resumed.site}. Your next action must be browser_snapshot to re-read the page, then continue the task from where you stopped. Never type credentials.`,
		});
		const doneEvent = { type: "login" as const, loginId: resumed.loginId, site: resumed.site, url: resumed.url, runId, status: "done" as const, ...(resumed.reason ? { reason: resumed.reason } : {}) };
		await persistConversationCardFromEvent(conversationId, doneEvent).catch(() => undefined);
		await onEvent(doneEvent);
		await persistCheckpoint(step);
	}

	// --- chamada ao modelo ---
	const closingSignal = () => AbortSignal.any([...(params.abortSignal ? [params.abortSignal] : []), AbortSignal.timeout(CLOSING_CALL_TIMEOUT_MS)]);
	const mediaMemo = createMediaMemo();
	const configuredOutputTokens = params.maxOutputTokens ?? (process.env.LLM_MAX_OUTPUT_TOKENS ? Number(process.env.LLM_MAX_OUTPUT_TOKENS) : undefined);
	// Trabalho longo escreve o documento em `create_file`: o argumento conta como saída, então o teto de chat (4.096 no v1)
	// não vale aqui. Nunca abaixo do que o run/bot já configurou.
	const docOutputTokens = Number(process.env.ATLAS_V2_DOC_MAX_OUTPUT_TOKENS) > 0 ? Number(process.env.ATLAS_V2_DOC_MAX_OUTPUT_TOKENS) : DOC_MAX_OUTPUT_TOKENS;
	/** O coordenador vai escrever o documento: portão já agiu, arquivo em partes aberto ou lista toda concluída (passo de entrega). */
	const writingDocument = () => {
		const items = currentTaskItems();
		return longWorkCoordinator && (documentGateFired || filePartsSoFar.size > 0 || (Boolean(items?.length) && openItems(items).length === 0));
	};
	let modelMaxOutput: number | null | undefined;
	const outputTokenCap = async (): Promise<number | undefined> => {
		if (!writingDocument()) return configuredOutputTokens;
		modelMaxOutput ??= await Promise.resolve(options.modelMaxOutputTokens?.(model)).catch(() => null);
		// Modelo sem teto conhecido no catálogo: fica o valor configurado.
		if (!modelMaxOutput) return configuredOutputTokens ?? docOutputTokens;
		return Math.min(modelMaxOutput, Math.max(configuredOutputTokens ?? 0, docOutputTokens));
	};
	const hygieneLastGroupChars = Math.max(STUB_LAST_GROUP_MAX_CHARS, (params.toolResultMaxChars ?? 0) + 4_000);
	const modelStep = async (
		history: LlmMessage[],
		toolChoice: "auto" | "none",
		messageId: string,
		closing = false,
	): Promise<{ content: string; toolCalls: LlmToolCall[]; providerItems?: LlmMessage["providerItems"]; usage: TokenUsage; result: CompleteChatWithToolsResult; telemetry: ReturnType<typeof modelStepTelemetry> }> => {
		await ensureContinue(closing ? params.abortSignal : undefined);
		await ensureNotPaused();
		const hygiene = applyPromptHygiene(history, {
			language,
			lastGroupMaxChars: hygieneLastGroupChars,
			contextLength,
			toolsJsonChars: toolsJsonCharsOf(tools),
			model,
			contextBudget: params.contextBudget ?? contextBudgetFor(params.contextMemory, contextLength),
			objectiveText: params.objective ?? lastUserMessage,
			taskState: () => taskTracker.snapshot(),
		});
		conversation = hygiene.messages;
		const taskNote = renderTaskListNote(taskTracker.taskList());
		const nowNote = process.env.ATLAS_NOW_NOTE === "off" ? null : todayNote(new Date(), params.timeZone);
		const layers = [taskNote, nowNote].filter((layer): layer is string => Boolean(layer));
		// Índice do caderno: camada fora do histórico (a higiene/compactação nunca o descarta). Títulos vêm de páginas,
		// então vai como contexto automático de usuário e não como instrução de sistema.
		const notebookIndex = notebook?.index();
		const notebookLayer: LlmMessage[] = notebookIndex ? [{ role: "user", content: `${AUTO_CONTEXT} ${notebookIndex}` }] : [];
		const withLayers: LlmMessage[] =
			layers.length || notebookLayer.length ? [...conversation, ...layers.map((content) => ({ role: "system" as const, content })), ...notebookLayer] : conversation;
		const transport = await resolveLlmMessagesForModel(withLayers, params.loadScreenshot, {
			canSeeUserImages: params.canSeeUserImages,
			canSeeScreenshots: canSeeImages,
			loadUserImage: params.loadUserImage ? (artifactId) => params.loadUserImage!(artifactId, { retryTransient: true }) : undefined,
			canReadNativePdf: params.attachments?.canReadNativePdf === true,
			loadUserPdf: params.attachments?.loadPdfDataUrl,
			memo: mediaMemo,
		});
		const outputCap = await outputTokenCap();
		let collected = "";
		let deltaTail = Promise.resolve();
		const callStartedAt = performance.now();
		let firstDeltaMs: number | undefined;
		const reasoningFor = await pickReasoningEffort(model);
		const result = await streamChat(
			{
				messages: transport,
				model,
				apiKey,
				tools,
				toolChoice,
				signal: closing ? closingSignal() : params.abortSignal,
				timeoutMs: closing ? CLOSING_CALL_TIMEOUT_MS : params.modelCallTimeoutMs,
				firstEventTimeoutMs: params.firstEventTimeoutMs,
				idleTimeoutMs: params.idleTimeoutMs,
				fallbackModels: params.fallbackModels,
				maxOutputTokens: outputCap,
				reasoningMaxTokens: params.reasoningMaxTokens,
				...(reasoningFor ? { reasoningEffort: reasoningFor } : {}),
				sessionId: !conversationId ? params.runId : `c${createHash("sha256").update(`${botId ?? ""}:${conversationId}`).digest("hex").slice(0, 31)}`,
				...(layers.length > 0 || notebookLayer.length > 0 ? { cacheStableIndex: conversation.length - 1 } : {}),
			},
			{
				onDelta: (delta) => {
					firstDeltaMs ??= performance.now() - callStartedAt;
					collected += delta;
					// Delta é só exibição ao vivo: falha ao gravar nunca descarta a resposta já recebida.
					deltaTail = deltaTail.then(() => Promise.resolve(onEvent({ type: "assistant_delta", id: messageId, delta }))).catch(() => undefined);
				},
			},
		);
		await deltaTail;
		lastModel = result.model;
		const usage = modelUsage(result);
		usageTotals = addUsage(usageTotals, usage);
		const callCost = callCostUsd(usage, fallbackPrices);
		if (callCost.estimated) estimatedCostUsd += callCost.costUsd;
		return {
			content: result.message.content ?? collected,
			toolCalls: (result.message.tool_calls ?? []).map((call) => ({ ...call, id: namespaceToolCallId(call.id, runId) })),
			providerItems: renameProviderItemCallIds(result.message.providerItems, (id) => namespaceToolCallId(id, runId)),
			usage,
			result,
			telemetry: modelStepTelemetry({ requestedModel: model, result, fallbackModelMs: performance.now() - callStartedAt, fallbackTtftMs: firstDeltaMs }),
		};
	};

	// --- execução de uma tool call ---
	const entryOf = (name: string) => mcp?.toolset.entries.get(name);
	const pendingMedia = new Map<string, LlmContentPart[]>();
	const awaiting: { kind?: AwaitingKind } = {};
	let loginToAsk: Extract<ComputerUseEvent, { type: "login" }> | undefined;

	const emitSynthetic = async (call: LlmToolCall, name: string, message: string, args: Record<string, unknown> = {}): Promise<CallOutcome> => {
		await onEvent({ type: "tool_call", id: call.id, name, args: call.function.arguments, step });
		await onEvent({ type: "tool_result", id: call.id, name, ok: false, summary: message });
		return { call, name, ok: false, summary: message, args };
	};

	/** Uso de um ajudante soma no pai ao vivo (custo informado, ou estimado quando o provedor não informa). */
	const addChildUsage = (usage: RunUsage) => {
		usageTotals = addUsage(usageTotals, usage);
		const cost = callCostUsd(usage, fallbackPrices);
		if (cost.estimated) estimatedCostUsd += cost.costUsd;
	};
	/** Ajudante = o mesmo laço v2 como run filho: dono, bot, autonomia, hooks e cancelamento do pai; só leitura. */
	const runHelperChild = (child: HelperChildInput) =>
		runEngineV2(
			{
				providerHealth,
				manager: params.manager,
				getSessionId: params.getSessionId,
				sandboxEnabled: false,
				model: child.model,
				apiKey,
				messages: child.messages,
				language: language,
				botId,
				userId,
				runId: child.runId,
				origin: SUBAGENT_ORIGIN,
				objective: child.objective,
				mcp,
				jev: params.jev,
				// Política em vigor do pai, congelada: o ajudante nunca a amplia.
				autonomy: { ...autonomyPolicy, exceptions: [...autonomyPolicy.exceptions] },
				maxSteps: child.budget.maxSteps,
				runStartedAt: Date.now(),
				toolFilter: child.toolFilter,
				// Os mesmos hooks antes da tool (lições do usuário, plano pendente) valem no filho.
				lessons: params.lessons,
				preToolRules: params.preToolRules,
				planPending: params.planPending,
				onEvent: child.onEvent,
				onStep: child.onStep,
				shouldContinue: params.shouldContinue,
				shouldPause: params.shouldPause,
				abortSignal: params.abortSignal,
				modelCallTimeoutMs: params.modelCallTimeoutMs,
				firstEventTimeoutMs: params.firstEventTimeoutMs,
				idleTimeoutMs: params.idleTimeoutMs,
				fallbackModels: params.fallbackModels,
				maxOutputTokens: params.maxOutputTokens,
				contextLength: child.contextLength ?? undefined,
				timeZone: params.timeZone,
				streamChat: async (chatParams, handlers) => {
					const result = await streamChat(chatParams, handlers);
					const usage = modelUsage(result);
					child.onUsage(usage);
					addChildUsage(usage);
					return result;
				},
			},
			{ profile: "chat", helper: { writer: child.writer, budget: child.budget, preactivateMcpTools: child.preactivateMcpTools } },
		);
	/** Tarefas que um ajudante já terminou antes de uma retomada (não rodam de novo). */
	const finishedGoals = new Set<string>();
	const helpersCtx: HelpersContext | undefined =
		notebook && hasToolInRun("delegate")
			? {
					parentRunId: runId,
					groupId: () => `${runId}-h${toolCallCounts.get("delegate") ?? 1}`,
					conversationId,
					userId,
					model,
					helperModel: options.helpers?.model ?? null,
					maxParallel: options.helpers?.maxParallel ?? 4,
					notebook,
					mcp,
					activeMcpTools: () => catalog.activeMcpTools(),
					isKnownModel: params.isKnownModel,
					getModelContextLength: async (modelId) => {
						const fromCatalog = await Promise.resolve(params.getModelContextLength?.(modelId)).catch(() => null);
						return fromCatalog ?? (modelId === model ? (contextLength ?? null) : null);
					},
					emit: onEvent,
					remaining: () => ({ costUsd: Math.max(0, budget.maxCostUsd - spentUsd()), activeMs: Math.max(0, budget.maxActiveMs - activeElapsedMs()) }),
					runChild: runHelperChild,
					step: () => step,
					deps: options.helpers?.deps ?? params.delegateDeps,
					finishedGoals,
					// Uso e entradas do ajudante já estão no pai: grava o checkpoint agora (a retomada não perde nem recontaria).
					onHelperDone: async (childRunId) => {
						accountedHelpers.add(childRunId);
						await persistCheckpoint(step).catch(() => undefined);
					},
				}
			: undefined;

	const buildContext = (call: LlmToolCall, signal: AbortSignal | undefined, forceConfirm = false): ToolContext => ({
		loginAsked,
		secrets: secretSession,
		health: providerHealth,
		hasTool: hasToolInRun,
		timeZone: params.timeZone,
		manager: manager.withExecutionContext?.({ ...executionContext, signal }) ?? manager,
		...(params.attachments?.present ? { attachments: { runtime: params.attachments, vmAvailable: sandboxEnabled } } : {}),
		showImages: {
			remaining: () => Math.max(0, 6 - shownImageCount),
			add: (count) => { shownImageCount += count; },
			emit: async (event) => {
				await persistConversationCardFromEvent(conversationId, event);
				await onEvent(event);
			},
		},
		...(imageModel ? { imageGeneration: {
			apiKey, model: imageModel,
			remaining: () => Math.max(0, maxGeneratedImages - generatedImageCount),
			add: (count: number) => { generatedImageCount += count; },
			onCost: (costUsd: number | undefined) => { usageTotals = addUsage(usageTotals, costUsd !== undefined ? { costUsd } : { costUnknownCalls: 1 }); },
		} } : {}),
		mcp,
		apiConnector: params.apiConnector ?? null,
		email: params.email ?? undefined,
		toolResultMaxChars: params.toolResultMaxChars,
		activateMcpTools: mcp ? catalog.activateMcpTools : undefined,
		nativeDeferral: catalog.deferral ?? undefined,
		abortSignal: signal,
		getSessionId: () => getSessionId({ ...executionContext, signal }),
		peekSessionId: params.peekSessionId,
		toolCallId: call.id,
		botId,
		userId,
		conversationId,
		runId,
		origin,
		...(origin === "routine" && params.routinePageId ? { routinePageId: params.routinePageId } : {}),
		autonomy: autonomyHandle,
		skillStore: params.skillStore,
		jevMcpMode: params.jevMcpMode,
		evaluateMcpWithJev: params.evaluateMcpWithJev,
		userRequestText: lastUserMessage,
		humanTurn,
		jev: params.jev,
		lessonFeedback: params.lessons?.recordFeedback,
		forceConfirm,
		mcpRun,
		objective: params.objective,
		lastUserText: lastUserPlainText(conversation),
		recentUserTexts: recentUserPlainTexts(conversation),
		recentAssistantTexts: recentAssistantPlainTexts(conversation),
		onRoutineMutated: params.onRoutineMutated,
		replyLanguage: language,
		...(params.alertRuleReader ? { alertRuleReader: params.alertRuleReader } : {}),
		...(params.pageValueFinder ? { pageValueFinder: params.pageValueFinder } : {}),
		getOperationalSnapshot: () => ({ step, model: lastModel, messages: conversation.length, consumedInputs: [...consumedInputIds] }),
		taskListStore,
		emitTaskList: emitTaskListEvent,
		...(notebookTools ? { notebook: notebookTools } : {}),
		...(helpersCtx ? { helpers: helpersCtx } : {}),
		createFileDeps: params.createFileDeps,
		runCodeDeps: params.runCodeDeps,
		emitFile: async (event) => {
			await persistConversationCardFromEvent(conversationId, event).catch(() => undefined);
			await onEvent(event);
		},
		emitChart: async (event) => {
			await persistConversationCardFromEvent(conversationId, event).catch(() => undefined);
			await onEvent(event);
		},
		pagesStore: params.pagesStore,
		pageShareStore: params.pageShareStore,
		emitPage: async (event) => {
			await persistConversationCardFromEvent(conversationId, event).catch(() => undefined);
			await onEvent(event);
		},
		canSeeImages,
		currentStep: () => step,
		listScreenshotArtifacts: () => {
			const ids: string[] = [];
			for (const message of conversation) {
				if (!Array.isArray(message.content)) continue;
				for (const part of message.content) if (part.type === "screenshot_ref" && !ids.includes(part.artifactId)) ids.push(part.artifactId);
			}
			return ids;
		},
	});

	const processCall = async (call: LlmToolCall, sub: number): Promise<CallOutcome> => {
		const name = call.function.name;
		let args: Record<string, unknown> = {};
		try {
			args = parseArgs(call.function.arguments);
		} catch (error) {
			return await emitSynthetic(call, name, error instanceof Error ? error.message : "invalid arguments");
		}
		// Só executa o que o modelo viu. Tool adiada: carrega o grupo e o modelo repete já com o schema.
		if (!hasToolInRun(name) || !tools.some((tool) => tool.function.name === name)) {
			if (catalog.deferral?.isDeferred(name)) {
				const { notes } = catalog.deferral.loadGroupOf(name);
				return await emitSynthetic(call, name, `Tool ${name} was not loaded; it is loaded now. Call it again.${notes ? `\n${notes}` : ""}`, args);
			}
			return await emitSynthetic(call, name, unavailableToolMessage(name, Boolean(mcp?.toolset.available.has(name)), tools.some((tool) => tool.function.name === "mcp_tool_search")), args);
		}
		const blockedMessage = supervisor.toolBlocked(name, step);
		if (blockedMessage) return { ...(await emitSynthetic(call, name, blockedMessage, args)), blocked: true };

		const entry = entryOf(name);
		const idempotencyKey = toolIdempotencyKey({ runId, decisionIndex: step, toolCallId: call.id, toolName: name });
		await onEvent({ type: "tool_call", id: call.id, name, args: call.function.arguments, step });

		const replay = await params.findCompletedTool?.(idempotencyKey);
		if (replay) {
			await onEvent({ type: "tool_result", id: call.id, name, ok: replay.ok, summary: replay.summary });
			if (replay.file) {
				await persistConversationCardFromEvent(conversationId, replay.file).catch(() => undefined);
				await onEvent(replay.file);
			}
			return { call, name, ok: replay.ok, summary: replay.summary, args };
		}
		const journaled = isJournaledWrite(name, entry);
		if (journaled) {
			const started = await params.findStartedTool?.(idempotencyKey);
			if (started) {
				await onEvent({ type: "tool_result", id: call.id, name, ok: false, summary: INTERRUPTED_WRITE_NOTE });
				return { call, name, ok: false, summary: INTERRUPTED_WRITE_NOTE, args };
			}
		}
		const argsHash = journaled ? hashEffectArgs(args) : undefined;
		await params.onStep?.({
			decisionIndex: step,
			subIndex: sub + 1,
			type: "tool",
			status: "running",
			idempotencyKey,
			inputJson: { name, args, ...(journaled ? { attemptId: idempotencyKey, argsHash } : {}) },
		});
		toolCallCounts.set(name, (toolCallCounts.get(name) ?? 0) + 1);
		if (entry) catalog.pinMcpTool(name);

		let summary = "";
		let ok = true;
		let uncertain = false;
		let image: string | undefined;
		let visionArtifactIds: string[] = [];
		let pendingCard = false;
		let loginEvent: Extract<ComputerUseEvent, { type: "login" }> | undefined;
		let fileEvent: Extract<ComputerUseEvent, { type: "file" }> | undefined;
		const cards: ComputerUseEvent[] = [];
		const startedAt = Date.now();
		try {
			await ensureContinue();
			const preTool = preTools.run(name, args, entry);
			if (preTool.error) throw new Error(preTool.error);
			// Documento de trabalho longo: as fontes e o que não foi confirmado vêm do caderno, não da memória do modelo.
			let toolArgs = args;
			if (name === "create_file" && typeof args.filename === "string") {
				const key = args.filename;
				const previous = filePartsSoFar.get(key) ?? "";
				if (notebook) toolArgs = withNotebookAppendix(args, notebook.snapshot(), language, previous);
				if (args.more === true && typeof args.content === "string") filePartsSoFar.set(key, `${previous}\n${args.content}`);
				else filePartsSoFar.delete(key);
			}
			const outcome = await runSandboxOperation(executionContext, isSandboxTool(name) ? 180_000 : undefined, (signal) => executeTool(name, toolArgs, buildContext(call, signal, preTool.forceConfirm)));
			if (isUntrustedContentTool(name) && !(isMcpToolName(name) && outcome.confirmEvent)) await markUntrusted();
			summary = outcome.summary;
			image = outcome.image;
			visionArtifactIds = outcome.visionArtifactIds ?? [];
			fileEvent = outcome.fileEvent;
			if (fileEvent) fileDelivered = true;
			loginEvent = outcome.loginEvent;
			// Sem humano (rotina/webhook): nota no lugar do cartão. Com humano: um cartão por site e conversa.
			if (loginEvent) {
				const unattended = unattendedLoginOutcome({ event: loginEvent, summary, unattended: isUnattendedOrigin(origin) });
				loginEvent = unattended.event;
				summary = unattended.summary;
			}
			if (loginEvent) {
				const deduped = dedupeLoginAsk({ event: loginEvent, summary, asked: (await loadRecentLoginAsks()).asked });
				loginEvent = deduped.event;
				summary = deduped.summary;
			}
			if (outcome.confirmEvent) {
				cards.push(outcome.confirmEvent);
				if ((outcome.confirmEvent.status ?? "pending") === "pending") { awaiting.kind = "confirm"; pendingCard = true; }
			}
			if (outcome.skillEvent) {
				cards.push(outcome.skillEvent);
				// Cartão só informativo (lista, "aprendi", detalhe): o run para, mas não espera decisão.
				if (outcome.skillEvent.learned !== true && ["listed", "created", "updated", "cleaned", "deleted", "shown"].includes(outcome.skillEvent.action)) awaiting.kind ??= "skill_card";
			}
			if (outcome.skillProposalEvent) {
				cards.push(outcome.skillProposalEvent);
				if ((outcome.skillProposalEvent.status ?? "pending") === "pending") awaiting.kind ??= "skill_card";
			}
			if (outcome.botProposalEvent) { cards.push(outcome.botProposalEvent); awaiting.kind ??= "skill_card"; }
			if (outcome.routineEvent) cards.push(outcome.routineEvent);
			if (!pendingCard) preTools.noteSuccess(name, entry);
			if (outcome.questionnaireEvent) { cards.push(outcome.questionnaireEvent); awaiting.kind ??= "questionnaire"; }
			if (outcome.profileEvent) {
				cards.push(outcome.profileEvent);
				if ((outcome.profileEvent.status ?? "pending") === "pending") awaiting.kind ??= "profile";
			}
		} catch (error) {
			if (params.abortSignal?.aborted) throw errorFromAbortSignal(params.abortSignal);
			if (isControlFlowError(error)) throw error;
			ok = false;
			if (isUntrustedContentTool(name)) await markUntrusted();
			uncertain = error instanceof ToolEffectUncertainError;
			summary = error instanceof Error ? error.message : "erro";
			if (!isSandboxTool(name) && classifyToolFailure(summary) === "argument") summary = withArgumentErrorHint(summary);
		}
		const durationMs = Date.now() - startedAt;
		let imageArtifactId: string | undefined;
		if (image && params.persistScreenshot && image.startsWith("data:")) imageArtifactId = await params.persistScreenshot(image.replace(/^data:image\/\w+;base64,/, ""));
		await params.onStep?.({
			decisionIndex: step,
			subIndex: sub + 1,
			type: "tool_result",
			status: ok ? "completed" : "failed",
			idempotencyKey,
			durationMs,
			outputJson: {
				summary,
				ok,
				status: buildToolResultStatus({ ok, writes: journaled && !pendingCard, uncertain, code: uncertain ? "no_result" : ok ? undefined : "other" }),
				...(fileEvent ? { file: fileEvent } : {}),
				...(imageArtifactId ? { imageArtifactId } : {}),
			},
		});
		await onEvent({ type: "tool_result", id: call.id, name, ok, summary });
		for (const card of cards) await onEvent(card);
		if (loginEvent) {
			// Nesta fase o login é sempre do usuário (sem preenchimento automático do Cofre): o cartão vai sem a oferta.
			const { vault: _offer, ...human } = loginEvent;
			loginToAsk = human;
			await persistConversationCardFromEvent(conversationId, human).catch(() => undefined);
			await onEvent(human);
		}
		if (fileEvent) {
			await persistConversationCardFromEvent(conversationId, fileEvent).catch(() => undefined);
			await onEvent(fileEvent);
		}
		// Imagens só entram no contexto depois do resultado da tool (a ordem das mensagens é a das chamadas).
		pendingMedia.set(call.id, imageArtifactId ? [{ type: "screenshot_ref", artifactId: imageArtifactId }] : visionArtifactIds.length > 0 && canSeeImages ? visionArtifactIds.map((artifactId): LlmContentPart => ({ type: "screenshot_ref", artifactId })) : []);
		return { call, name, ok, summary, args };
	};
	const parallelSafe = (call: LlmToolCall): boolean => {
		const name = call.function.name;
		if (!tools.some((tool) => tool.function.name === name) || supervisor.toolBlocked(name, step)) return false;
		const entry = entryOf(name);
		if (entry) return entry.readOnly && decideAction(autonomyPolicy, entry.autonomyMeta) === "allow";
		return getToolRegistration(name)?.readOnly === true && !isSandboxTool(name) && name !== "update_task_list";
	};

	/** Roda o lote de tool calls do passo e devolve os resultados na ordem das chamadas. */
	const runBatch = async (calls: LlmToolCall[]): Promise<CallOutcome[]> => {
		if (calls.some((call) => isJournaledWrite(call.function.name, entryOf(call.function.name)))) await persistCheckpoint(step);
		const outcomes: CallOutcome[] = [];
		if (calls.length > 1 && calls.every(parallelSafe)) {
			for (let at = 0; at < calls.length; at += MAX_PARALLEL_READS) {
				const chunk = calls.slice(at, at + MAX_PARALLEL_READS);
				outcomes.push(...(await Promise.all(chunk.map((call, index) => processCall(call, at + index)))));
			}
			return outcomes;
		}
		for (const [index, call] of calls.entries()) {
			if (awaiting.kind || loginToAsk) {
				outcomes.push({ call, name: call.function.name, ok: false, summary: "Not executed: waiting for the user.", args: {}, skipped: true });
				continue;
			}
			outcomes.push(await processCall(call, index));
		}
		return outcomes;
	};

	/** Escreve os resultados no histórico, aplica o Supervisor e devolve o motivo de aborto por repetição, se houver. */
	const settleBatch = (outcomes: CallOutcome[]): RunStop | undefined => {
		let abort: RunStop | undefined;
		for (const outcome of outcomes) {
			conversation.push({ role: "tool", tool_call_id: outcome.call.id, content: outcome.summary });
			const media = pendingMedia.get(outcome.call.id);
			pendingMedia.delete(outcome.call.id);
			if (media && media.length > 0) conversation.push({ role: "user", content: [{ type: "text", text: "Screenshot atual da tela:" }, ...media] });
		}
		for (const outcome of outcomes) {
			if (outcome.blocked || outcome.skipped) continue;
			const verdict = supervisor.recordTool({
				step,
				name: outcome.name,
				argsKey: toolArgsKey(outcome.name, outcome.args),
				resultKey: toolResultKey(outcome.summary, outcome.ok),
				ok: outcome.ok,
				message: outcome.ok ? undefined : outcome.summary,
			});
			for (const note of verdict.notes) appendToLatestToolResult(conversation, note);
			abort ??= verdict.abort;
		}
		return abort;
	};

	/** Parada por cartão que espera o usuário, ou pausa por login. */
	const stopIfWaiting = async (): Promise<RunComputerUseResult | undefined> => {
		if (loginToAsk) {
			const ask = loginToAsk;
			loginToAsk = undefined;
			pendingLogin = { loginId: ask.loginId, site: ask.site, url: ask.url, ...(ask.reason === "captcha" ? { reason: "captcha" as const } : {}), ...(ask.composioToolkit ? { composioToolkit: ask.composioToolkit } : {}), ...(ask.connector ? { connector: ask.connector } : {}) };
			await persistCheckpoint(step);
			await params.onLoginRequired?.({ ...pendingLogin });
			throw new AgentRunPausedError("Aguardando o login do usuário");
		}
		if (awaiting.kind) {
			await persistCheckpoint(step);
			return { text: "", model: lastModel, hitWall: false, usage: usageTotals, stop: { reason: "awaiting_confirmation", detail: awaiting.kind } };
		}
		return undefined;
	};

	const finishOk = async (text: string, stop: RunStop, messageId: string): Promise<RunComputerUseResult> => {
		// O portão do documento retirou uma resposta do chat e nenhum arquivo saiu (create_file falhou, limite de arquivos,
		// modelo respondeu curto): o usuário não pode ficar com menos do que já tinha, então o texto original volta.
		if (gatedText && !fileDelivered && countWords(text) < countWords(gatedText)) {
			if (text) await onEvent({ type: "assistant_discard", id: messageId, reason: "missing_file" });
			messageId = `${messageId}-restored`;
			text = gatedText;
			await onEvent({ type: "assistant_delta", id: messageId, delta: text });
		}
		// Itens descartados e pendências vão na resposta; o delta mantém o balão ao vivo igual ao gravado.
		const items = currentTaskItems();
		const unresolved = stop.detail === "tasklist_open" ? openItems(items).map((item) => item.content) : [];
		const withNotes = appendUnconfirmed(text, { dropped: droppedItems(items), unresolved, language });
		if (withNotes !== text) await onEvent({ type: "assistant_delta", id: messageId, delta: withNotes.slice(text.length) });
		taskTracker.setPhase("done");
		await persistCheckpoint(step + 1);
		await checkpointTail;
		return { text: withNotes, model: lastModel, hitWall: false, usage: usageTotals, stop };
	};

	/** Última chamada SEM tools: entrega o que há, nunca aborta sem resposta. */
	const deliver = async (stop: RunStop, instruction: string): Promise<RunComputerUseResult> => {
		conversation.push({ role: "user", content: `${AUTO_CONTEXT} ${instruction}` });
		const messageId = `${turnId}-final`;
		let text = "";
		try {
			const final = await modelStep(conversation, "none", messageId, true);
			text = sanitizeAssistantText(final.content);
		} catch (error) {
			// Cancelamento, lease perdido, pausa e abort nunca viram 'entrega': sobem para o worker.
			if (params.abortSignal?.aborted) throw errorFromAbortSignal(params.abortSignal);
			if (isControlFlowError(error)) throw error;
		}
		if (!text) {
			text = budgetStopFallbackText(stop.reason, language);
			await onEvent({ type: "assistant_delta", id: messageId, delta: text });
		}
		return await finishOk(text, stop, messageId);
	};

	// Observabilidade: quais tools o modelo viu neste run.
	void Promise.resolve(
		params.onStep?.({
			decisionIndex: 0,
			subIndex: OFFERED_TOOLS_SUB_INDEX,
			type: "checkpoint",
			status: "completed",
			idempotencyKey: `${runId}:offered-tools`,
			outputJson: { offeredTools: tools.map((tool) => tool.function.name), ...(catalog.deferral ? { deferredTools: catalog.deferral.pending() } : {}), engine: "v2", profile: options.profile },
		}),
	).catch(() => undefined);

	// Retomada com ajudantes: soma o custo dos filhos que terminaram depois do último checkpoint (sem recontar os já somados)
	// e lembra as tarefas que eles já fizeram.
	if (parsed && helpersCtx) {
		const list = options.helpers?.listChildren ?? ((parentRunId: string, ownerId: string) => listSubagentRuns(parentRunId, ownerId));
		for (const child of await Promise.resolve(list(runId, userId)).catch(() => [])) {
			if (!child.finishedAt) continue;
			finishedGoals.add(child.objective);
			if (accountedHelpers.has(child.id)) continue;
			accountedHelpers.add(child.id);
			const usage = child.usageJson as Partial<RunUsage> | null;
			if (usage && typeof usage === "object") {
				addChildUsage({
					promptTokens: Number(usage.promptTokens) || 0,
					completionTokens: Number(usage.completionTokens) || 0,
					totalTokens: Number(usage.totalTokens) || 0,
					...(typeof usage.costUsd === "number" ? { costUsd: usage.costUsd } : {}),
					...(usage.costUnknownCalls ? { costUnknownCalls: Number(usage.costUnknownCalls) } : {}),
				});
			}
		}
	}

	// Retomada no meio de um lote: as tool calls sem resultado rodam primeiro.
	const lastAssistant = [...conversation].reverse().find((message) => message.role === "assistant");
	let abortStop: RunStop | undefined;
	if (lastAssistant?.tool_calls?.length) {
		const answered = completedToolCallIds(conversation);
		const pending = lastAssistant.tool_calls.filter((call) => !answered.has(call.id));
		if (pending.length > 0) {
			abortStop = settleBatch(await runBatch(pending));
			step += 1;
			await persistCheckpoint(step);
			const waiting = await stopIfWaiting();
			if (waiting) return waiting;
		}
	}

	let finishRetries = 0;
	let emptyRetries = 0;
	let truncatedReply: { id: string; text: string } | undefined;
	try {
		for (;;) {
			await ensureContinue();
			await ensureNotPaused();
			if (abortStop) return await deliver(abortStop, helperRole ? HELPER_DELIVERY_INSTRUCTION : deliveryInstruction("loop_repeat"));
			// Mensagens do usuário durante o run: viram nota; "cancelar" para o run.
			if (params.consumeSteerInputs) {
				for (const input of await params.consumeSteerInputs()) {
					if (consumedInputIds.has(input.id)) continue;
					if (input.mode === "cancel") throw new AgentRunCancelledError("Cancel solicitado via input");
					if (input.mode === "queue") continue;
					consumedInputIds.add(input.id);
					conversation.push({ role: "user", content: `[User message during the task] ${input.content}` });
					await onEvent({ type: "input_consumed", inputId: input.id, mode: input.mode ?? "join", content: input.content });
				}
			}
			const gate = supervisor.gate({ costUsd: spentUsd(), activeMs: activeElapsedMs(), step });
			if (gate.action === "deliver") return await deliver(gate.stop, helperRole ? HELPER_DELIVERY_INSTRUCTION : gate.instruction);
			if (gate.note && !appendToLatestToolResult(conversation, gate.note)) conversation.push({ role: "user", content: `${AUTO_CONTEXT} ${gate.note}` });

			await persistCheckpoint(step);
			const stepId = truncatedReply?.id ?? `${turnId}-step-${step}`;
			const outcome = await modelStep(conversation, "auto", stepId);
			const { content, toolCalls, providerItems, usage, result, telemetry } = outcome;
			const finishReason = result.finishReason;
			const text = truncatedReply && toolCalls.length === 0 ? `${truncatedReply.text}${sanitizeAssistantText(content)}` : sanitizeAssistantText(content);
			truncatedReply = undefined;
			await params.onStep?.({
				decisionIndex: step,
				subIndex: 0,
				type: "model",
				status: "completed",
				idempotencyKey: `${runId}:model:${step}`,
				tokens: usage.totalTokens,
				durationMs: telemetry.modelMs,
				telemetry,
				...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
				outputJson: { content: text, toolCallIds: toolCalls.map((call) => call.id), ...(finishReason ? { finishReason } : {}) },
			});

			if (toolCalls.length === 0) {
				// Resposta cortada pelo limite de saída ou stream incompleto não é conclusão: uma nova tentativa.
				const finishClass = classifyFinish(finishReason);
				if ((finishClass === "truncated" || finishClass === "incomplete") && finishRetries < 1) {
					finishRetries += 1;
					if (finishClass === "truncated" && text.length > 0) {
						conversation.push({ role: "assistant", content: text });
						conversation.push({ role: "user", content: `${AUTO_CONTEXT} ${TRUNCATED_REPLY_NOTE}` });
						truncatedReply = { id: stepId, text };
					}
					step += 1;
					continue;
				}
				if (text.length === 0) {
					if (emptyRetries < 1) {
						emptyRetries += 1;
						conversation.push({ role: "user", content: `${AUTO_CONTEXT} ${EMPTY_REPLY_NOTE}` });
						step += 1;
						continue;
					}
					await onEvent({ type: "assistant_delta", id: stepId, delta: EMPTY_REPLY_FALLBACK_TEXT });
					return await finishOk(EMPTY_REPLY_FALLBACK_TEXT, { reason: "answered", detail: "empty_reply" }, stepId);
				}
				// Lista de tarefas obrigatória em trabalho longo: sem itens abertos para entregar.
				const verdict = taskGate.check(currentTaskItems());
				if (verdict.kind === "note") {
					await onEvent({ type: "assistant_discard", id: stepId, reason: "items_open" });
					conversation.push({ role: "assistant", content: text });
					conversation.push({ role: "user", content: `${AUTO_CONTEXT} ${verdict.text}` });
					step += 1;
					continue;
				}
				// Resultado grande (ou pedido de relatório/estudo/análise) vira documento: uma vez por run.
				if (
					longWorkCoordinator &&
					!documentGateFired &&
					hasToolInRun("create_file") &&
					needsDocumentDelivery({ text, request: lastUserMessage, hasFile: fileDelivered })
				) {
					documentGateFired = true;
					gatedText = text;
					await onEvent({ type: "assistant_discard", id: stepId, reason: "missing_file" });
					conversation.push({ role: "assistant", content: text });
					conversation.push({ role: "user", content: `${AUTO_CONTEXT} ${DOCUMENT_DELIVERY_NOTE}` });
					step += 1;
					continue;
				}
				const stop: RunStop = verdict.kind === "release" ? { reason: "answered", detail: "tasklist_open" } : { reason: "answered" };
				return await finishOk(text, stop, stepId);
			}

			finishRetries = 0;
			conversation.push({ role: "assistant", content: text.length > 0 ? text : null, tool_calls: toolCalls, ...(providerItems ? { providerItems } : {}) });
			const outcomes = await runBatch(toolCalls);
			abortStop = settleBatch(outcomes);
			step += 1;
			await persistCheckpoint(step);
			const waiting = await stopIfWaiting();
			if (waiting) return waiting;
			await params.onStep?.({ decisionIndex: step - 1, subIndex: 99, type: "checkpoint", status: "completed", idempotencyKey: `${runId}:checkpoint:${step - 1}` });
		}
	} finally {
		await checkpointTail;
	}
}
