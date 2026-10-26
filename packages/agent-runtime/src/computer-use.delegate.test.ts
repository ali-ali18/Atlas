import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsParams, CompleteChatWithToolsResult } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { appendAgentStep, createSubagentRun, failOrphanSubagentRuns, finishSubagentRun } from "@workspace/db";
import { DELEGATE_TASK_TOOL } from "./tools/delegate-task.js";
import { SUBAGENT_SYSTEM_PROMPT } from "./tools/subagent-prompt.js";
import { buildMcpToolset } from "./mcp/registry.js";
import type { McpRuntime } from "./mcp/runtime.js";
import { AgentRunCancelledError } from "./errors.js";
import { OFFERED_TOOLS_SUB_INDEX, SYSTEM_PROMPT, runComputerUse, type RuntimeStepRecord } from "./computer-use.js";

/**
 * F5 — delegate_task: subagentes em paralelo, LLM mockado, sem banco nem rede.
 */

vi.mock("@workspace/db", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@workspace/db")>();
	return {
		...actual,
		getBotProfile: vi.fn(async () => null),
		listBotSkills: vi.fn(async () => []),
		searchSkillVersions: vi.fn(async () => []),
		persistConversationCardFromEvent: vi.fn(async () => undefined),
		createSubagentRun: vi.fn(),
		finishSubagentRun: vi.fn(async () => true),
		failOrphanSubagentRuns: vi.fn(async () => 0),
		appendAgentStep: vi.fn(async () => undefined),
	};
});

type Ev = Record<string, unknown> & { type: string };
type Usage = { promptTokens: number; completionTokens: number; totalTokens: number };

function toolCalls(calls: Array<{ id: string; name: string; args: Record<string, unknown> }>): CompleteChatWithToolsResult {
	return {
		model: "test-model",
		message: {
			role: "assistant",
			content: null,
			tool_calls: calls.map((call) => ({
				id: call.id,
				type: "function" as const,
				function: { name: call.name, arguments: JSON.stringify(call.args) },
			})),
		},
	};
}

const say = (content: string, usage?: Usage): CompleteChatWithToolsResult => ({
	model: "test-model",
	message: { role: "assistant", content },
	usage,
});

/** Filho que leu uma fonte (1 tool ok no conector) antes de responder; sem tool o resultado seria "partial". */
const readThen = (params: CompleteChatWithToolsParams, text: string, usage?: Usage) =>
	params.messages.some((m) => m.role === "tool")
		? say(text, usage)
		: toolCalls([{ id: "r1", name: "mcp__github__read_things", args: {} }]);

const isChild = (params: CompleteChatWithToolsParams) => {
	const first = params.messages[0];
	return typeof first?.content === "string" && first.content.includes("focused sub-agent");
};
const childGoal = (params: CompleteChatWithToolsParams) => {
	const user = params.messages.find((m) => m.role === "user");
	return typeof user?.content === "string" ? user.content : "";
};

const connector = (slug: string, name: string) => ({
	id: `conn-${slug}`,
	slug,
	name,
	disabledTools: [],
	tools: [
		{
			name: "read_things",
			description: "Lê",
			inputSchema: { type: "object", properties: {} },
			annotations: { readOnlyHint: true },
		},
		{
			name: "create_note",
			description: "Cria nota",
			inputSchema: { type: "object", properties: {} },
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
		},
	],
});

let childCounter = 0;

async function runParent(input: {
	abortSignal?: AbortSignal;
	llm: (params: CompleteChatWithToolsParams, ctx: { parentCalls: number }) => Promise<CompleteChatWithToolsResult>;
	origin?: string;
	findCompletedTool?: NonNullable<Parameters<typeof runComputerUse>[0]["findCompletedTool"]>;
	autonomy?: Parameters<typeof runComputerUse>[0]["autonomy"];
	withMcp?: boolean;
	/** Conectores do pai (padrão: github + slack). */
	connectors?: ReturnType<typeof connector>[];
	/** Teto de tools expostas: baixo força o catálogo adiado. */
	maxTools?: number;
	budget?: Parameters<typeof runComputerUse>[0]["budget"];
	onStep?: (step: RuntimeStepRecord) => Promise<void>;
	/** Parâmetros extras do runComputerUse (ex.: configuração da conta). */
	extra?: Partial<Parameters<typeof runComputerUse>[0]>;
}) {
	const mcp: McpRuntime | null = input.withMcp
		? {
				toolset: buildMcpToolset(input.connectors ?? [connector("github", "GitHub"), connector("slack", "Slack")], {
					autonomy: { level: "autonomous", exceptions: [] },
					maxTools: input.maxTools,
				}),
				call: vi.fn(async () => ({ ok: true, text: "dados", truncated: false })),
			}
		: null;
	const events: Ev[] = [];
	const seen: Array<{ child: boolean; tools: string[]; goal: string }> = [];
	const ctx = { parentCalls: 0 };
	const result = await runComputerUse({
		manager: {} as SandboxManager,
		getSessionId: async () => {
			throw new Error("sandbox nao deve ser usado");
		},
		sandboxEnabled: true,
		model: "test-model",
		apiKey: "test",
		messages: [{ role: "user", content: "pesquisa o preço do MacBook em 3 lojas" }],
		botId: "bot-1",
		userId: "user-1",
		runId: "run-parent",
		origin: input.origin ?? "chat",
		maxSteps: 8,
		mcp,
		autonomy: input.autonomy,
		budget: input.budget,
		abortSignal: input.abortSignal,
		findCompletedTool: input.findCompletedTool,
		onStep: input.onStep,
		...input.extra,
		onEvent: (event) => {
			events.push(event as unknown as Ev);
		},
		streamChat: async (params, handlers) => {
			const child = isChild(params);
			seen.push({ child, tools: params.tools.map((t) => t.function.name), goal: childGoal(params) });
			if (!child) ctx.parentCalls += 1;
			const reply = await input.llm(params, ctx);
			if (reply.message.content) handlers?.onDelta?.(reply.message.content);
			return reply;
		},
	});
	return { result, events, seen, mcp };
}

const delegateThree = toolCalls([
	{
		id: "d1",
		name: "delegate_task",
		args: {
			tasks: [
				{ goal: "Preço no Mercado Livre" },
				{ goal: "Preço na Amazon" },
				{ goal: "Preço na Kabum", context: "MacBook M5 Pro 24GB/1TB" },
			],
		},
	},
]);

describe("delegate_task (F5)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		childCounter = 0;
		vi.mocked(createSubagentRun).mockImplementation(async () => ({ id: `child-${++childCounter}` }));
	});

	it("replay: 3 pesquisas independentes em paralelo, filhos vinculados ao pai, uma resposta final", async () => {
		const window: Array<{ goal: string; start: number; end: number }> = [];
		const { result, events, seen } = await runParent({
			withMcp: true,
			llm: async (params, ctx) => {
				if (isChild(params)) {
					const goal = childGoal(params);
					const store = goal.includes("Amazon") ? "Amazon" : goal.includes("Kabum") ? "Kabum" : "Mercado Livre";
					// 2ª chamada do filho (depois de ler a fonte): só responde, fora da janela medida.
					if (params.messages.some((m) => m.role === "tool")) return readThen(params, `${store}: R$ 19.999 (fonte ${store})`, { promptTokens: 100, completionTokens: 50, totalTokens: 150 });
					const entry = { goal, start: Date.now(), end: 0 };
					window.push(entry);
					await new Promise((resolve) => setTimeout(resolve, 40));
					entry.end = Date.now();
					return readThen(params, "");
				}
				if (ctx.parentCalls === 1) return delegateThree;
				return say("Melhor preço: Mercado Livre, R$ 19.999.", { promptTokens: 10, completionTokens: 5, totalTokens: 15 });
			},
		});

		// Filhos vinculados ao pai, com dono do pai (nunca dos args).
		expect(createSubagentRun).toHaveBeenCalledTimes(3);
		for (const [input] of vi.mocked(createSubagentRun).mock.calls) {
			expect(input).toMatchObject({ parentRunId: "run-parent", userId: "user-1" });
		}
		// Paralelo: todos começam antes de o primeiro terminar.
		expect(window).toHaveLength(3);
		expect(Math.max(...window.map((w) => w.start))).toBeLessThan(Math.min(...window.map((w) => w.end)));
		// Resultado agregado no tool_result do pai.
		const toolResult = events.find((e) => e.type === "tool_result" && e.name === "delegate_task");
		expect(toolResult).toMatchObject({ ok: true });
		const summary = String(toolResult?.summary);
		expect(summary).toContain("Amazon: R$ 19.999");
		expect(summary).toContain("Kabum: R$ 19.999");
		expect(summary).toContain("Mercado Livre: R$ 19.999");
		expect(summary).toContain("untrusted");
		expect(result.text).toContain("Melhor preço");
		// Eventos.
		expect(events.filter((e) => e.type === "subagent_started")).toHaveLength(3);
		const done = events.filter((e) => e.type === "subagent_done");
		expect(done).toHaveLength(3);
		expect(done.every((e) => e.status === "ok")).toBe(true);
		// Contexto do filho vem no prompt dele; o pai vê delegate_task, o filho não.
		expect(seen.find((s) => s.child && s.goal.includes("Kabum"))?.goal).toContain("MacBook M5 Pro 24GB/1TB");
		expect(seen.find((s) => !s.child)?.tools).toContain("delegate_task");
		// Uso dos filhos soma no pai: 3 x 150 + 15 (a 1ª chamada do pai não trouxe uso).
		expect(result.usage.totalTokens).toBe(3 * 150 + 15);
		expect(finishSubagentRun).toHaveBeenCalledTimes(3);
		expect(vi.mocked(finishSubagentRun).mock.calls.every(([arg]) => arg.status === "completed")).toBe(true);
	});

	it("o filho herda a configuração da conta do pai (prazos, reserva, teto de saída)", async () => {
		const received: Array<{ child: boolean; params: CompleteChatWithToolsParams }> = [];
		await runParent({
			extra: {
				modelCallTimeoutMs: 45_000,
				firstEventTimeoutMs: 15_000,
				idleTimeoutMs: 10_000,
				fallbackModels: ["fb/one"],
				maxOutputTokens: 8192,
			},
			llm: async (params, ctx) => {
				received.push({ child: isChild(params), params });
				if (isChild(params)) return say("ok");
				if (ctx.parentCalls === 1) return delegateThree;
				return say("pronto");
			},
		});
		const children = received.filter((r) => r.child);
		expect(children).toHaveLength(3);
		for (const { params } of children) {
			expect(params).toMatchObject({
				timeoutMs: 45_000,
				firstEventTimeoutMs: 15_000,
				idleTimeoutMs: 10_000,
				fallbackModels: ["fb/one"],
			});
			expect(params.maxOutputTokens).toBeLessThanOrEqual(8192);
			expect(params.maxOutputTokens).toBeGreaterThan(0);
		}
	});

	it("o filho não vê propose_*, delegate_task nem sandbox, e usa prompt de subagente", async () => {
		const { seen } = await runParent({
			llm: async (params, ctx) => {
				if (isChild(params)) return say("ok");
				if (ctx.parentCalls === 1) {
					return toolCalls([{ id: "d1", name: "delegate_task", args: { tasks: [{ goal: "A" }, { goal: "B" }] } }]);
				}
				return say("feito");
			},
		});
		const childSeen = seen.filter((s) => s.child);
		expect(childSeen).toHaveLength(2);
		for (const { tools } of childSeen) {
			for (const forbidden of ["delegate_task", "propose_routine", "propose_questionnaire", "propose_profile_update", "navigate", "browser_click", "screenshot", "memory", "list_routines"]) {
				expect(tools, forbidden).not.toContain(forbidden);
			}
			expect(tools).toContain("web_search");
		}
	});

	describe("Firecrawl e conectores de leitura nos filhos", () => {
		const firecrawl = () => ({
			...connector("firecrawl", "Firecrawl"),
			tools: [
				{ name: "firecrawl_search", description: "Busca", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
				{ name: "firecrawl_scrape", description: "Scrape", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
				{ name: "firecrawl_crawl", description: "Crawl", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } },
			],
		});
		const delegateOne = async (connectors: ReturnType<typeof connector>[], requestedTools?: string[]) => {
			const { seen } = await runParent({
				withMcp: true,
				connectors,
				maxTools: 1, // catálogo adiado: nada exposto no passo 1
				llm: async (params, ctx) => {
					if (isChild(params)) return say("ok");
					if (ctx.parentCalls === 1) {
						return toolCalls([{ id: "d1", name: "delegate_task", args: { tasks: [{ goal: "preço na Kabum", ...(requestedTools ? { tools: requestedTools } : {}) }] } }]);
					}
					return say("feito");
				},
			});
			return seen.find((s) => s.child)?.tools ?? [];
		};

		it("filho nasce com busca/scrape do Firecrawl já carregados, sem escrita", async () => {
			const tools = await delegateOne([firecrawl(), connector("github", "GitHub")]);
			expect(tools).toEqual(expect.arrayContaining(["mcp__firecrawl__firecrawl_search", "mcp__firecrawl__firecrawl_scrape"]));
			expect(tools).not.toContain("mcp__firecrawl__firecrawl_crawl");
			expect(tools).not.toContain("mcp__github__create_note");
			expect(tools).toContain("mcp_tool_search");
		});

		it("com Firecrawl, o filho mantém web_search/web_extract como reserva (créditos do conector acabam)", async () => {
			const tools = await delegateOne([firecrawl()]);
			expect(tools).toEqual(expect.arrayContaining(["web_search", "web_extract"]));
			expect(tools).toContain("mcp__firecrawl__firecrawl_search");
		});

		it("regressão real: pai pede tools [web_search, web_extract] e o filho ainda recebe o Firecrawl", async () => {
			// Run cmundhp9...: o pai passou só as nativas, o filtro cortou o Firecrawl
			// e o filho ficou com web_search bloqueada e web_extract sem JS.
			const tools = await delegateOne(
				[{ ...firecrawl(), catalogId: "firecrawl" }],
				["web_search", "web_extract"],
			);
			expect(tools).toEqual(expect.arrayContaining(["mcp__firecrawl__firecrawl_search", "mcp__firecrawl__firecrawl_scrape", "web_search", "web_extract"]));
		});

		it("sem Firecrawl, o filho mantém web_search/web_extract mesmo pedidos pelo pai", async () => {
			const tools = await delegateOne([connector("github", "GitHub")], ["web_search", "web_extract"]);
			expect(tools).toEqual(expect.arrayContaining(["web_search", "web_extract"]));
		});

		it("sem Firecrawl conectado, nada de MCP pré-carregado", async () => {
			const tools = await delegateOne([connector("github", "GitHub"), connector("slack", "Slack")]);
			expect(tools.filter((name) => name.startsWith("mcp__"))).toEqual([]);
		});

		it("prompt do filho manda usar conector web de forma genérica", () => {
			expect(SUBAGENT_SYSTEM_PROMPT).toContain("you may use them for web work");
		});
	});

	it("um filho falha: o pai recebe 'failed' e continua", async () => {
		const { result, events } = await runParent({
			withMcp: true,
			llm: async (params, ctx) => {
				if (isChild(params)) {
					if (childGoal(params).includes("Kabum")) throw new Error("Kabum fora do ar token=Bearer abcdefghijklmnop1234");
					return readThen(params, "Amazon: R$ 20.000");
				}
				if (ctx.parentCalls === 1) {
					return toolCalls([
						{ id: "d1", name: "delegate_task", args: { tasks: [{ goal: "Amazon" }, { goal: "Kabum" }] } },
					]);
				}
				return say("Só consegui a Amazon.");
			},
		});
		const toolResult = events.find((e) => e.type === "tool_result" && e.name === "delegate_task");
		expect(toolResult).toMatchObject({ ok: true });
		const summary = String(toolResult?.summary);
		expect(summary).toContain("[ok]");
		expect(summary).toContain("[failed]");
		expect(summary).not.toContain("abcdefghijklmnop1234");
		expect(events.filter((e) => e.type === "subagent_done").map((e) => e.status).sort()).toEqual(["failed", "ok"]);
		expect(result.text).toBe("Só consegui a Amazon.");
		const statuses = vi.mocked(finishSubagentRun).mock.calls.map(([arg]) => arg.status).sort();
		expect(statuses).toEqual(["completed", "failed"]);
	});

	it("todos os filhos falham: o pai recebe erro honesto (ok:false) e segue", async () => {
		const { result, events } = await runParent({
			llm: async (params, ctx) => {
				if (isChild(params)) throw new Error("sem rede");
				if (ctx.parentCalls === 1) {
					return toolCalls([{ id: "d1", name: "delegate_task", args: { tasks: [{ goal: "A" }] } }]);
				}
				return say("Vou pesquisar eu mesmo.");
			},
		});
		expect(events.find((e) => e.type === "tool_result" && e.name === "delegate_task")).toMatchObject({ ok: false });
		expect(result.text).toBe("Vou pesquisar eu mesmo.");
	});

	it("orçamento do filho estoura: o relatório parcial volta", async () => {
		const { events } = await runParent({
			llm: async (params, ctx) => {
				if (isChild(params)) {
					const lastUser = [...params.messages].reverse().find((m) => m.role === "user");
					const asksSummary = typeof lastUser?.content === "string" && params.toolChoice === "none";
					if (asksSummary) return say("Parcial: Amazon R$ 20.000 (Kabum não consultada).");
					// Primeiro passo já gasta mais que o teto de tokens do filho.
					const first = toolCalls([{ id: "w1", name: "web_search", args: { query: "macbook" } }]);
					return {
						...first,
						message: { ...first.message, content: "Achei: Amazon R$ 20.000." },
						usage: { promptTokens: 300_000, completionTokens: 1000, totalTokens: 301_000 },
					};
				}
				if (ctx.parentCalls === 1) {
					return toolCalls([{ id: "d1", name: "delegate_task", args: { tasks: [{ goal: "Amazon" }] } }]);
				}
				return say("Resumo parcial.");
			},
		});
		const done = events.find((e) => e.type === "subagent_done");
		expect(done).toMatchObject({ status: "partial" });
		const toolResult = events.find((e) => e.type === "tool_result" && e.name === "delegate_task");
		expect(toolResult).toMatchObject({ ok: true });
		expect(String(toolResult?.summary)).toContain("[partial]");
		expect(String(toolResult?.summary)).toContain("Parcial: Amazon R$ 20.000");
		expect(String(toolResult?.summary)).toContain("stopped early");
		expect(vi.mocked(finishSubagentRun).mock.calls[0]?.[0].status).toBe("budget_exhausted");
	});

	it("resume do pai não reexecuta o delegate_task já concluído", async () => {
		const findCompletedTool = vi.fn(async () => ({ ok: true, summary: "relatórios anteriores" }));
		const { events, result } = await runParent({
			findCompletedTool,
			llm: async (_params, ctx) => {
				if (ctx.parentCalls === 1) return delegateThree;
				return say("Consolidado.");
			},
		});
		expect(createSubagentRun).not.toHaveBeenCalled();
		expect(events.filter((e) => e.type === "subagent_started")).toHaveLength(0);
		expect(events.find((e) => e.type === "tool_result" && e.name === "delegate_task")).toMatchObject({
			summary: "relatórios anteriores",
		});
		expect(result.text).toBe("Consolidado.");
	});

	it("args inválidos (4 tarefas) viram erro para o modelo, sem abrir filhos", async () => {
		const { events } = await runParent({
			llm: async (_params, ctx) => {
				if (ctx.parentCalls === 1) {
					return toolCalls([
						{ id: "d1", name: "delegate_task", args: { tasks: [1, 2, 3, 4].map((n) => ({ goal: `t${n}` })) } },
					]);
				}
				return say("ok");
			},
		});
		expect(createSubagentRun).not.toHaveBeenCalled();
		const toolResult = events.find((e) => e.type === "tool_result" && e.name === "delegate_task");
		expect(toolResult).toMatchObject({ ok: false });
		expect(String(toolResult?.summary)).toContain("At most 3 tasks");
	});

	it("rotina/webhook e subagente não recebem delegate_task", async () => {
		for (const origin of ["routine", "webhook", "subagent"]) {
			const { seen } = await runParent({ origin, llm: async () => say("ok") });
			expect(seen[0]?.tools, origin).not.toContain("delegate_task");
		}
		const chat = await runParent({ origin: "chat", llm: async () => say("ok") });
		expect(chat.seen[0]?.tools).toContain("delegate_task");
	});

	it("filho herda a autonomia do pai e nunca a excede: conector bloqueado some do filho", async () => {
		const { seen } = await runParent({
			withMcp: true,
			autonomy: { level: "autonomous", exceptions: [{ connector: "slack", mode: "blocked" }] },
			llm: async (params, ctx) => {
				if (isChild(params)) return say("ok");
				if (ctx.parentCalls === 1) {
					return toolCalls([{ id: "d1", name: "delegate_task", args: { tasks: [{ goal: "ler" }] } }]);
				}
				return say("pronto");
			},
		});
		const child = seen.find((s) => s.child);
		expect(child?.tools).toContain("mcp__github__read_things");
		expect(child?.tools).not.toContain("mcp__slack__read_things");
		// Escrita nunca vai para o filho, mesmo com autonomia total.
		expect(child?.tools).not.toContain("mcp__github__create_note");
		// O pai (que pode escrever) segue vendo a tool de escrita.
		expect(seen.find((s) => !s.child)?.tools).toContain("mcp__github__create_note");
	});

	it("filho não abre card nem para o pai; tool MCP de escrita alucinada no filho não executa", async () => {
		const { mcp, events } = await runParent({
			withMcp: true,
			llm: async (params, ctx) => {
				if (isChild(params)) {
					const calls = params.messages.filter((m) => m.role === "tool").length;
					if (calls === 0) return toolCalls([{ id: "c1", name: "mcp__github__create_note", args: {} }]);
					return say("Não consegui escrever.");
				}
				if (ctx.parentCalls === 1) {
					return toolCalls([{ id: "d1", name: "delegate_task", args: { tasks: [{ goal: "anota" }] } }]);
				}
				return say("fim");
			},
		});
		expect(mcp?.call).not.toHaveBeenCalled();
		expect(events.filter((e) => e.type === "confirm")).toHaveLength(0);
	});

	it("cancelar o pai cancela os filhos e propaga o cancelamento", async () => {
		await expect(
			runParent({
				llm: async (params, ctx) => {
					if (isChild(params)) throw new AgentRunCancelledError();
					if (ctx.parentCalls === 1) return delegateThree;
					return say("nunca");
				},
			}),
		).rejects.toBeInstanceOf(AgentRunCancelledError);
		const statuses = vi.mocked(finishSubagentRun).mock.calls.map(([arg]) => arg.status);
		expect(statuses).toHaveLength(3);
		expect(statuses.every((s) => s === "cancelled")).toBe(true);
	});

	it("ao retomar, filhos órfãos do mesmo pai são falhados antes de abrir novos", async () => {
		await runParent({
			llm: async (params, ctx) => {
				if (isChild(params)) return say("ok");
				if (ctx.parentCalls === 1) {
					return toolCalls([{ id: "d1", name: "delegate_task", args: { tasks: [{ goal: "A" }] } }]);
				}
				return say("fim");
			},
		});
		expect(failOrphanSubagentRuns).toHaveBeenCalledWith("run-parent", "user-1");
		expect(appendAgentStep).toHaveBeenCalled();
	});

	it("prompt tem a seção Delegation e a descrição da tool não proíbe lojas por causa do browser", () => {
		expect(SYSTEM_PROMPT).toContain("Delegation:");
		expect(SYSTEM_PROMPT).toContain("Call it ONCE with one task per part");
		expect(SYSTEM_PROMPT).toContain("They cannot use the browser");
		// O pai não dita nomes de tool nativa: o conector (Firecrawl) substitui.
		expect(SYSTEM_PROMPT).toContain("do not name web_search/web_extract");
		expect(SYSTEM_PROMPT).not.toContain("Sub-agents have `web_search`");
		const description = DELEGATE_TASK_TOOL.function.description ?? "";
		expect(description).toContain("Do not name web_search/web_extract");
		expect(description).not.toContain("'web_search')");
		expect(description).not.toContain("anything that needs the browser");
		expect(description).toContain("Sub-agents cannot use the browser: give them tasks solvable with web search, page scraping or read-only connectors.");
	});

	it("replay: preços em 3 lojas — delegate_task exposta, prompt orienta delegar e o modelo delega", async () => {
		const { seen, events } = await runParent({
			llm: async (params, ctx) => {
				if (isChild(params)) return say("R$ 19.999");
				if (ctx.parentCalls === 1) {
					const system = params.messages[0]?.content;
					expect(typeof system === "string" && system.includes("Delegation:")).toBe(true);
					expect(params.tools.map((t) => t.function.name)).toContain("delegate_task");
					return delegateThree;
				}
				return say("Melhor: Mercado Livre.");
			},
		});
		expect(seen.find((entry) => !entry.child)?.tools).toContain("delegate_task");
		expect(events.filter((e) => e.type === "subagent_started")).toHaveLength(3);
	});

	it("persiste as tools oferecidas num passo idempotente do run", async () => {
		const steps: RuntimeStepRecord[] = [];
		await runParent({
			onStep: async (step) => {
				steps.push(step);
			},
			llm: async () => say("ok"),
		});
		const offered = steps.find((step) => step.idempotencyKey === "run-parent:offered-tools");
		expect(offered).toMatchObject({ decisionIndex: 0, subIndex: OFFERED_TOOLS_SUB_INDEX, type: "checkpoint", status: "completed" });
		expect((offered?.outputJson as { offeredTools: string[] }).offeredTools).toContain("delegate_task");
	});
});

afterEach(() => vi.useRealTimers());

it("B1: delegate_task termina após 180s dentro do orçamento do filho", async () => {
	vi.useFakeTimers();
	vi.mocked(finishSubagentRun).mockClear();
	const work = runParent({
		withMcp: true,
		budget: { maxWallMs: 600_000 },
		llm: async (params, ctx) => {
			if (isChild(params)) {
				if (!params.messages.some((m) => m.role === "tool")) return readThen(params, "");
				await new Promise((resolve) => setTimeout(resolve, 200_000));
				return say("Relatório após trabalho demorado.");
			}
			return ctx.parentCalls === 1 ? delegateThree : say("Concluído.");
		},
	});
	await vi.advanceTimersByTimeAsync(200_001);
	const result = await work;
	expect(result.result.text).toBe("Concluído.");
	expect(
		vi.mocked(finishSubagentRun).mock.calls.map(([arg]) => arg.status),
	).toEqual(["completed", "completed", "completed"]);
});

it("B1: cancelar o pai aborta o sinal de todos os filhos sem ação posterior", async () => {
	vi.useFakeTimers();
	vi.mocked(finishSubagentRun).mockClear();
	const controller = new AbortController();
	const childSignals: AbortSignal[] = [];
	const subsequent = vi.fn();
	const work = runParent({
		abortSignal: controller.signal,
		llm: async (params, ctx) => {
			if (isChild(params)) {
				expect(params.signal).toBeDefined();
				childSignals.push(params.signal!);
				await new Promise<void>((_resolve, reject) =>
					params.signal!.addEventListener(
						"abort",
						() => reject(params.signal!.reason),
						{ once: true },
					),
				);
				subsequent();
				return say("Nunca.");
			}
			return ctx.parentCalls === 1 ? delegateThree : say("Nunca.");
		},
	});
	const rejected = expect(work).rejects.toBeInstanceOf(AgentRunCancelledError);
	await vi.advanceTimersByTimeAsync(1);
	expect(childSignals).toHaveLength(3);
	controller.abort(new AgentRunCancelledError());
	await rejected;
	await vi.advanceTimersByTimeAsync(1);
	expect(childSignals.every((signal) => signal.aborted)).toBe(true);
	expect(subsequent).not.toHaveBeenCalled();
	expect(
		vi.mocked(finishSubagentRun).mock.calls.map(([arg]) => arg.status),
	).toEqual(["cancelled", "cancelled", "cancelled"]);
});

describe("V2: delegação cega no replay do pai", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		childCounter = 0;
		vi.mocked(createSubagentRun).mockImplementation(async () => ({ id: `child-${++childCounter}` }));
	});

	it("depois de usar o navegador, delegar leitura de URL volta erro com a dica e nenhum filho nasce", async () => {
		const { result, events } = await runParent({
			llm: async (_params, ctx) => {
				// A 1ª chamada só carrega a tool (catálogo adiado); a 2ª roda no sandbox.
				if (ctx.parentCalls <= 2) return toolCalls([{ id: `n${ctx.parentCalls}`, name: "navigate", args: { url: "https://site.example/" } }]);
				if (ctx.parentCalls === 3) {
					return toolCalls([
						{ id: "d1", name: "delegate_task", args: { tasks: [{ goal: "Open https://site.example/course/1 and summarize it" }] } },
					]);
				}
				return say("Vou ler eu mesmo.");
			},
		});
		const delegate = events.find((e) => e.type === "tool_result" && e.name === "delegate_task");
		expect(delegate).toMatchObject({ ok: false });
		expect(String(delegate?.summary)).toContain("Sub-agents cannot use your browser session");
		expect(createSubagentRun).not.toHaveBeenCalled();
		expect(result.text).toBe("Vou ler eu mesmo.");
	});
});

describe("replay: quando o bot delega", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		childCounter = 0;
		vi.mocked(createSubagentRun).mockImplementation(async () => ({ id: `child-${++childCounter}` }));
	});

	const hinted = (params: CompleteChatWithToolsParams) =>
		params.messages.some((m) => m.role === "system" && typeof m.content === "string" && m.content.includes("split into 2-3 independent"));

	// O modelo mockado segue a dica: com ela (e a tool no 1º passo) delega um fornecedor por tarefa.
	const followHint = async (params: CompleteChatWithToolsParams, ctx: { parentCalls: number }) => {
		if (isChild(params)) return say(`${childGoal(params).split("\n")[1] ?? "fornecedor"}: R$ 12,90/kg`);
		if (ctx.parentCalls === 1 && hinted(params) && params.tools.some((t) => t.function.name === "delegate_task")) {
			return toolCalls([
				{
					id: "dg",
					name: "delegate_task",
					args: { tasks: ["Fornecedor A", "Fornecedor B", "Fornecedor C"].map((title) => ({ title, goal: `Search the web for the price of cinnamon at ${title}.` })) },
				},
			]);
		}
		return say("Comparação pronta: o Fornecedor A é o mais barato.");
	};

	it("'pesquisa o preço da canela em 3 fornecedores e compara': a dica chega sem Jev e o bot delega em paralelo", async () => {
		const { events, seen } = await runParent({
			llm: followHint,
			extra: { messages: [{ role: "user", content: "pesquisa o preço da canela em 3 fornecedores e compara" }] },
		});
		expect(seen[0]!.tools).toContain("delegate_task");
		expect(events.filter((e) => e.type === "subagent_started")).toHaveLength(3);
		expect(events.find((e) => e.type === "tool_result" && e.name === "delegate_task")).toMatchObject({ ok: true });
	});

	it("'oi': nenhuma dica e nenhuma delegação", async () => {
		const { events, result } = await runParent({
			llm: followHint,
			extra: { messages: [{ role: "user", content: "oi" }] },
		});
		expect(events.some((e) => e.type === "subagent_started")).toBe(false);
		expect(createSubagentRun).not.toHaveBeenCalled();
		expect(result.text).toBe("Comparação pronta: o Fornecedor A é o mais barato.");
	});
});
