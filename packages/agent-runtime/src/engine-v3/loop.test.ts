import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatTool, CompleteChatWithToolsParams, CompleteChatWithToolsResult, LlmToolCall } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { RUN_EVENT_TYPES, runTerminalKey, type AgentRunCheckpoint, type ComputerUseEvent, type EffectiveAutonomy } from "@workspace/shared";
import { buildMcpToolset } from "../mcp/registry.js";
import type { McpRuntime } from "../mcp/runtime.js";
import type { ComputerUseParams, RuntimeStepRecord } from "../run-types.js";
import { getToolMeta } from "../tools/registry/tool-meta.js";
import { EMPTY_REPLY_FALLBACK_TEXT } from "../execution/task-state.js";
import { runEngineV3, type EngineV3Options } from "./loop.js";
import { SKIPPED_FOR_USER_MESSAGE, UNKNOWN_STATUS_NOTE } from "./failures.js";

vi.mock("@workspace/db", async (original) => ({
	...(await original<typeof import("@workspace/db")>()),
	getBotProfile: vi.fn(async () => ({ description: "A bot that is already configured." })),
	searchMemoryEntries: vi.fn(async () => []),
	listBotSkills: vi.fn(async () => []),
	searchSkillVersions: vi.fn(async () => []),
	listRoutines: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
	upsertTaskListCard: vi.fn(async () => undefined),
	getConversationUntrustedAt: vi.fn(async () => null),
	markConversationUntrusted: vi.fn(async () => undefined),
	markMcpTaskGrantsUntrusted: vi.fn(async () => undefined),
	findExecutedConfirmCall: vi.fn(async () => null),
	persistJevStatusCard: vi.fn(async () => undefined),
	loadAutonomyContext: vi.fn(async () => ({ accountRaw: null, botRaw: null, botName: "Cookie" })),
	saveSkillPendingIntent: vi.fn(async () => undefined),
}));

const erp = {
	id: "conn-erp",
	slug: "erp",
	name: "ERP",
	disabledTools: [],
	tools: [
		{ name: "buscar_cliente", description: "Busca cliente", inputSchema: { type: "object", properties: { nome: { type: "string" }, id: { type: "integer" } } }, annotations: { readOnlyHint: true } },
		{ name: "criar_proposta", description: "Cria proposta", inputSchema: { type: "object", properties: { cliente: { type: "string" } } }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
	],
};
const READ = "mcp__erp__buscar_cliente";
const WRITE = "mcp__erp__criar_proposta";
const balanced = { level: "balanced", exceptions: [] } as unknown as EffectiveAutonomy;

const call = (id: string, name: string, args: Record<string, unknown> | string = {}): LlmToolCall => ({
	id,
	type: "function",
	function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
});
const tools = (...calls: LlmToolCall[]): CompleteChatWithToolsResult => ({ model: "m", message: { role: "assistant", content: null, tool_calls: calls }, finishReason: "tool_calls" });
const say = (content: string, finishReason: CompleteChatWithToolsResult["finishReason"] = "stop"): CompleteChatWithToolsResult => ({ model: "m", message: { role: "assistant", content }, finishReason });
/** Nomes que o manifesto (bloco de contexto) cita: `nome (resumo)` ou `nome, nome`. */
const manifestNames = (messages: CompleteChatWithToolsParams["messages"]): string[] => {
	const context = messages.find((message) => message.role === "user" && typeof message.content === "string" && message.content.startsWith("[context]"));
	if (!context || typeof context.content !== "string") return [];
	return [...context.content.matchAll(/(?:^- [^:]+: |; |, )([a-z][\w]*)/gm)].map((match) => match[1]!);
};
const read = (index: number) => tools(call(`r${index}`, READ, { nome: `cliente ${index}` }));

/** `toolNames` = array enviado; `visible` = array + nomes do manifesto (tudo o que o modelo pode chamar). */
type Request = { params: CompleteChatWithToolsParams; toolNames: string[]; visible: string[]; texts: string[] };
type ScriptItem = CompleteChatWithToolsResult | ((request: Request) => CompleteChatWithToolsResult | Promise<CompleteChatWithToolsResult>);

async function runV3(input: {
	script: ScriptItem[];
	text?: string;
	origin?: string;
	humanTurn?: boolean;
	params?: Partial<ComputerUseParams>;
	options?: EngineV3Options;
	mcpResult?: (args: Record<string, unknown>) => { ok: boolean; text: string };
}) {
	const events: ComputerUseEvent[] = [];
	const steps: RuntimeStepRecord[] = [];
	const checkpoints: AgentRunCheckpoint[] = [];
	const requests: Request[] = [];
	const queue = [...input.script];
	const mcpCall = vi.fn(async (_name: string, args: Record<string, unknown>) => ({ truncated: false, ...(input.mcpResult?.(args) ?? { ok: true, text: "cliente encontrado" }) }));
	const mcp = { toolset: buildMcpToolset([erp], { autonomy: input.params?.autonomy ?? balanced }), call: mcpCall } as unknown as McpRuntime;
	const result = await runEngineV3(
		{
			manager: {} as SandboxManager,
			getSessionId: async () => "session-1",
			sandboxEnabled: false,
			model: "m",
			apiKey: "test",
			runId: "run-v3",
			userId: "user-a",
			botId: "bot-cookie",
			conversationId: "conv-1",
			origin: input.origin ?? "chat",
			humanTurn: input.humanTurn ?? (input.origin ?? "chat") === "chat",
			messages: [{ role: "user", content: input.text ?? "Veja o cliente Acme" }],
			timeZone: "America/Sao_Paulo",
			mcp,
			autonomy: balanced,
			onEvent: (event) => {
				events.push(event);
			},
			onStep: async (step) => {
				steps.push(step);
			},
			onCheckpoint: async (checkpoint) => {
				checkpoints.push(JSON.parse(JSON.stringify(checkpoint)) as AgentRunCheckpoint);
			},
			streamChat: async (params, handlers) => {
				const request: Request = {
					params,
					toolNames: params.tools.map((tool: ChatTool) => tool.function.name),
					visible: [...params.tools.map((tool: ChatTool) => tool.function.name), ...manifestNames(params.messages)],
					texts: params.messages.map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? ""))),
				};
				requests.push(request);
				const next = queue.shift();
				if (!next) throw new Error("roteiro do modelo acabou");
				const reply = typeof next === "function" ? await next(request) : next;
				if (reply.message.content) handlers?.onDelta?.(reply.message.content);
				return reply;
			},
			...input.params,
		},
		input.options,
		{ sleep: async () => undefined },
	);
	const results = events.filter((event): event is Extract<ComputerUseEvent, { type: "tool_result" }> => event.type === "tool_result");
	return { result, events, steps, checkpoints, requests, results, mcpCall };
}

beforeEach(() => vi.clearAllMocks());

describe("motor v3: estados e saídas", () => {
	it("DONE: resposta sem tool encerra o turno na hora", async () => {
		const { result, requests, events } = await runV3({ script: [say("Oi! Tudo certo.")] });
		expect(result.text).toBe("Oi! Tudo certo.");
		expect(result.stop).toEqual({ reason: "answered" });
		expect(requests).toHaveLength(1);
		expect(events.map((event) => event.type)).toEqual(["assistant_delta"]);
	});

	it("MODEL_STEP → TOOLS → MODEL_STEP → DONE, sem rodapé nem nota no texto", async () => {
		const { result, results, requests } = await runV3({ script: [read(1), say("O cliente 1 existe.")] });
		expect(results).toEqual([expect.objectContaining({ name: READ, ok: true })]);
		expect(result.text).toBe("O cliente 1 existe.");
		expect(requests[1]!.params.messages.filter((message) => message.role === "system")).toHaveLength(requests[0]!.params.messages.filter((message) => message.role === "system").length);
	});

	it("nenhuma mensagem system entra no meio do run", async () => {
		const { requests } = await runV3({ script: [say("abc", "length"), read(1), say("", "stop"), say("fim")] });
		const systemsAt = (request: Request) => request.params.messages.filter((message) => message.role === "system").length;
		for (const request of requests) expect(systemsAt(request)).toBe(systemsAt(requests[0]!));
	});

	it("replay Cookie: anunciar ('vou fazer X') sem tool ENCERRA o turno; só sinal estrutural empurra", async () => {
		const text = "Cookie, abre o Gemini na VM e me traz um resumo deste vídeo do YouTube: https://youtu.be/abc";
		const announced = await runV3({ text, script: [say("Vou abrir o Gemini na VM e pedir o resumo do vídeo.")] });
		// Documenta o comportamento: sem regex sobre o texto, o laço não continua sozinho.
		expect(announced.requests).toHaveLength(1);
		expect(announced.result.stop).toEqual({ reason: "answered" });
		// Com a própria lista aberta (estado declarado pelo modelo), há UM empurrão; se ele parar de novo, o turno acaba.
		const withList = await runV3({
			text,
			script: [
				tools(call("t1", "update_task_list", { items: [{ content: "Abrir o Gemini na VM", status: "in_progress" }, { content: "Pedir o resumo", status: "pending" }] })),
				say("Vou abrir o Gemini na VM agora."),
				say("Ainda vou abrir."),
			],
		});
		expect(withList.requests).toHaveLength(3);
		expect(withList.requests[2]!.texts.at(-1)).toMatch(/^\[runtime\] Your task list still has 2 open items: Abrir o Gemini na VM; Pedir o resumo/);
		expect(withList.result.text).toBe("Ainda vou abrir.");
		expect(withList.result.stop).toEqual({ reason: "answered", detail: "tasklist_open" });
	});
});

describe("motor v3: empurrões estruturais", () => {
	it("E1 truncado: continua no mesmo balão, teto 2", async () => {
		const { result, requests, events } = await runV3({ script: [say("parte 1 ", "length"), say("parte 2 ", "length"), say("parte 3", "length")] });
		expect(requests).toHaveLength(3);
		expect(requests[1]!.texts.at(-1)).toMatch(/^\[runtime\] Your reply was cut/);
		expect(result.text).toBe("parte 1 parte 2 parte 3");
		const ids = new Set(events.filter((event) => event.type === "assistant_delta").map((event) => (event as { id: string }).id));
		expect(ids.size).toBe(1);
	});

	it("E2 vazio: um empurrão e depois o texto fixo honesto", async () => {
		const { result, requests } = await runV3({ script: [say(""), say("")] });
		expect(requests).toHaveLength(2);
		expect(requests[1]!.texts.at(-1)).toBe("[runtime] Your last reply was empty. Answer the user or call a tool.");
		expect(result.text).toBe(EMPTY_REPLY_FALLBACK_TEXT);
		expect(result.stop).toEqual({ reason: "answered", detail: "empty_reply" });
	});

	it("E3 tool malformada: finish tool_calls sem chamada parseável empurra; JSON inválido volta como erro da tool com a assinatura", async () => {
		const { result, requests, results } = await runV3({ script: [say("", "tool_calls"), tools(call("bad", READ, "{nome: ")), say("ok")] });
		expect(requests[1]!.texts.at(-1)).toMatch(/^\[runtime\] Your last reply announced a tool call/);
		expect(results[0]).toMatchObject({ name: READ, ok: false });
		expect(results[0]!.summary).toMatch(/Invalid arguments.*Expected: mcp__erp__buscar_cliente\(nome\?: string, id\?: number\)/s);
		expect(result.text).toBe("ok");
	});

	it("teto global de 3 empurrões por run", async () => {
		const { requests, result } = await runV3({ script: [say("a", "length"), say("b", "length"), say(""), say("", "tool_calls")] });
		expect(requests).toHaveLength(4);
		expect(result.text).toBe("ab");
	});
});

describe("motor v3: limites", () => {
	it("rotina sem conversa para o cartão chega em 40 passos → FINAL_STEP com toolChoice none, tools mantidas, nada executado e resposta honesta", async () => {
		// Com conversa, o limite estaciona com o cartão "Continuo?" (ver limit-wait.test.ts); sem ela, vale o passo final.
		const script: ScriptItem[] = Array.from({ length: 40 }, (_, index) => read(index));
		script.push(tools(call("late", READ, { nome: "tarde" })));
		const { result, requests, results, checkpoints, mcpCall } = await runV3({ origin: "routine", text: "Confira os clientes", params: { conversationId: undefined }, script: [...script.slice(0, 40), { ...say("Conferi 40 clientes; faltam os demais. Continuo?"), message: { role: "assistant", content: "Conferi 40 clientes; faltam os demais. Continuo?", tool_calls: [call("ignored", READ, { nome: "x" })] } }] });
		expect(requests).toHaveLength(41);
		const final = requests[40]!;
		expect(final.params.toolChoice).toBe("none");
		expect(final.toolNames).toEqual(requests[0]!.toolNames);
		expect(final.texts.at(-1)).toMatch(/^\[runtime\] Limit reached \(step limit for runs without a person\).*whether you should continue/s);
		expect(results).toHaveLength(40);
		expect(mcpCall).toHaveBeenCalledTimes(40);
		expect(result.text).toBe("Conferi 40 clientes; faltam os demais. Continuo?");
		expect(result.stop).toEqual({ reason: "budget_steps", detail: "v3_steps_unattended" });
		expect(checkpoints.at(-1)).toMatchObject({ engine: "v3", nextStepIndex: 41 });
	});

	it("chat com humano passa de 40 passos (sem limite salvo os 200 de segurança)", async () => {
		const script: ScriptItem[] = [...Array.from({ length: 45 }, (_, index) => read(index)), say("Pronto.")];
		const { result, requests } = await runV3({ script });
		expect(requests).toHaveLength(46);
		expect(result.stop).toEqual({ reason: "answered" });
	});

	it("teto de passos do dono vale e o modelo responde no FINAL_STEP", async () => {
		const { result, requests } = await runV3({ options: { ownerSteps: 2 }, script: [read(1), read(2), say("Fiz 2 de 3.")] });
		expect(requests[2]!.params.toolChoice).toBe("none");
		expect(result).toMatchObject({ text: "Fiz 2 de 3.", stop: { reason: "budget_steps", detail: "v3_steps_owner" } });
	});

	it("repetição: 3ª igual recebe nota, 5ª não executa, 2 bloqueios = FINAL_STEP", async () => {
		const same = () => tools(call(`s${Math.random()}`, READ, { nome: "Acme" }));
		const { results, requests, result, mcpCall } = await runV3({ script: [same(), same(), same(), same(), same(), same(), say("Parei: a busca repete o mesmo resultado.")] });
		expect(mcpCall).toHaveBeenCalledTimes(4);
		expect(requests[3]!.params.messages.at(-1)!.content).toMatch(/Same call and same result 3 times/);
		expect(results[4]!.summary).toMatch(/^blocked: repeated/);
		expect(results[5]!.summary).toMatch(/^blocked: repeated/);
		expect(requests.at(-1)!.params.toolChoice).toBe("none");
		expect(requests.at(-1)!.texts.at(-1)).toMatch(/stopped: repeated calls/);
		expect(result.stop?.reason).toBe("loop_repeat");
	});
});

describe("motor v3: recusas entram na rede de repetição", () => {
	it("mesma tool desconhecida: 3ª recebe nota, 5ª é bloqueada, 2 bloqueios = FINAL_STEP", async () => {
		const ghost = (index: number) => tools(call(`g${index}`, "publish_tiktok", { video: "a" }));
		const { results, requests, result } = await runV3({ script: [ghost(1), ghost(2), ghost(3), ghost(4), ghost(5), ghost(6), say("Não dá para publicar no TikTok.")] });
		expect(results[2]!.summary).toMatch(/Unknown tool "publish_tiktok"[\s\S]*Same call and same result 3 times/);
		expect(results[4]!.summary).toMatch(/^blocked: repeated/);
		expect(results[5]!.summary).toMatch(/^blocked: repeated/);
		expect(requests.at(-1)!.params.toolChoice).toBe("none");
		expect(result.stop?.reason).toBe("loop_repeat");
	});

	it("args inválidos e chamada negada também sobem a escada", async () => {
		const bad = (index: number) => tools(call(`b${index}`, READ, "{nome: "));
		const denied = (index: number) => tools(call(`d${index}`, WRITE, { cliente: "Acme" }));
		const invalid = await runV3({ script: [bad(1), bad(2), bad(3), say("fim")] });
		expect(invalid.results[2]!.summary).toMatch(/Invalid arguments[\s\S]*Same call and same result 3 times/);
		const routine = await runV3({ origin: "routine", script: [denied(1), denied(2), denied(3), denied(4), denied(5), say("fim")] });
		expect(routine.results[2]!.summary).toMatch(/Not available in this run[\s\S]*Same call and same result 3 times/);
		expect(routine.results[4]!.summary).toMatch(/^blocked: repeated/);
	});
});

describe("motor v3: política decide", () => {
	it("rotina não vê nem executa escrita de conector; needsHuman some sem humano", async () => {
		const { requests, results, mcpCall } = await runV3({ origin: "routine", script: [tools(call("w", WRITE, { cliente: "Acme" })), say("Não consegui criar sozinho.")] });
		expect(requests[0]!.visible).toContain(READ);
		expect(requests[0]!.visible).not.toContain(WRITE);
		expect(requests[0]!.visible.filter((name) => getToolMeta(name)?.needsHuman)).toEqual([]);
		expect(results[0]).toMatchObject({ name: WRITE, ok: false });
		expect(results[0]!.summary).toMatch(/^Not available in this run: no human present/);
		expect(mcpCall).not.toHaveBeenCalled();
	});

	it("chat sem turno humano (run sintético) também esconde needsHuman", async () => {
		const human = await runV3({ script: [say("ok")] });
		const synthetic = await runV3({ humanTurn: false, script: [say("ok")] });
		const needsHuman = (names: string[]) => names.filter((name) => getToolMeta(name)?.needsHuman);
		expect(needsHuman(synthetic.requests[0]!.visible)).toEqual([]);
		expect(needsHuman(human.requests[0]!.visible).length).toBeGreaterThan(0);
	});

	it("chat com humano: escrita pede o cartão de confirmação existente e o run estaciona (PARKED)", async () => {
		const { result, events, mcpCall, steps } = await runV3({ script: [tools(call("w", WRITE, { cliente: "Acme" }), call("r", READ, { nome: "x" }))] });
		expect(events.some((event) => event.type === "confirm" && (event.status ?? "pending") === "pending")).toBe(true);
		expect(mcpCall).not.toHaveBeenCalled();
		expect(result.stop).toEqual({ reason: "awaiting_confirmation", detail: "confirm" });
		const toolSpan = steps.find((step) => step.type === "tool_result" && step.telemetry?.toolName === WRITE);
		expect(toolSpan?.telemetry?.policyDecision).toBe("confirm");
	});
});

describe("motor v3: steering, falhas e retomada", () => {
	it("mensagem do usuário no meio do lote pula o resto com motivo e entra como user depois dos resultados", async () => {
		let polls = 0;
		const { results, requests, events } = await runV3({
			params: {
				consumeSteerInputs: async () => {
					polls += 1;
					return polls === 2 ? [{ id: "in-1", content: "Na verdade, procure a Beta", mode: "join" }] : [];
				},
			},
			script: [tools(call("t", "update_task_list", { items: [{ content: "Buscar", status: "in_progress" }] }), call("r", READ, { nome: "Acme" })), say("Buscando a Beta."), say("Busquei a Beta.")],
		});
		expect(results.map((event) => [event.name, event.ok])).toEqual([["update_task_list", true], [READ, false]]);
		expect(results[1]!.summary).toBe(SKIPPED_FOR_USER_MESSAGE);
		const messages = requests[1]!.params.messages;
		expect(messages.at(-1)).toMatchObject({ role: "user", content: "Na verdade, procure a Beta" });
		expect(messages.at(-2)).toMatchObject({ role: "tool" });
		expect(events.some((event) => event.type === "input_consumed")).toBe(true);
	});

	it("tool que falha volta ok:false com a mensagem real; nome desconhecido traz os próximos; camelCase normaliza", async () => {
		const { results, mcpCall } = await runV3({
			mcpResult: () => ({ ok: false, text: "ERP fora do ar (503)" }),
			script: [tools(call("a", READ, { nome: "x" })), tools(call("b", "curent_time")), tools(call("c", "mcp__erp__buscarCliente", { nome: "y" })), say("fim")],
		});
		expect(results[0]).toMatchObject({ ok: false });
		expect(results[0]!.summary).toMatch(/ERP fora do ar/);
		expect(results[1]!.summary).toMatch(/Unknown tool "curent_time". Closest available: current_time/);
		expect(results[2]!.name).toBe(READ);
		expect(mcpCall).toHaveBeenCalledTimes(2);
	});

	it("transporte: erro transitório repete e cai no fallback configurado", async () => {
		const transient = Object.assign(new Error("upstream 503"), { status: 503 });
		const models: string[] = [];
		const fail = (request: Request) => {
			models.push(request.params.model);
			throw transient;
		};
		const { result } = await runV3({
			params: { fallbackModels: ["fb"] },
			script: [fail, fail, fail, (request) => { models.push(request.params.model); return say("respondi pelo fallback"); }],
		});
		expect(models).toEqual(["m", "m", "m", "fb"]);
		expect(result.text).toBe("respondi pelo fallback");
	});

	it("crash no meio do lote: tool sem resultado vira 'status desconhecido' e não roda de novo", async () => {
		const restored: AgentRunCheckpoint = {
			version: 1,
			messages: [{ role: "user", content: "Crie a proposta" }],
			nextStepIndex: 3,
			model: "m",
			llmMessages: [
				{ role: "system", content: "sys" },
				{ role: "user", content: "Crie a proposta" },
				{ role: "assistant", content: null, tool_calls: [call("run-v3:c1", READ, { nome: "x" })] },
			],
			engine: "v3",
			engineV3: { nudges: { empty: 1 } },
		} as AgentRunCheckpoint;
		const { requests, mcpCall, result, checkpoints } = await runV3({ params: { restoredCheckpoint: restored }, script: [say(""), say("retomei")] });
		expect(mcpCall).not.toHaveBeenCalled();
		expect(requests[0]!.params.messages.at(-1)).toMatchObject({ role: "tool", content: UNKNOWN_STATUS_NOTE });
		// O teto do empurrão "vazio" veio do checkpoint: não há segundo empurrão.
		expect(requests).toHaveLength(1);
		expect(result.text).toBe(EMPTY_REPLY_FALLBACK_TEXT);
		expect(checkpoints.every((checkpoint) => checkpoint.engine === "v3")).toBe(true);
	});
});

describe("motor v3: contrato e tracing", () => {
	it("só emite tipos de RUN_EVENT_TYPES e nunca um terminal (o fim é do worker)", async () => {
		const runs = await Promise.all([
			runV3({ script: [read(1), tools(call("t", "update_task_list", { items: [{ content: "a", status: "completed" }] })), say("x", "length"), say("y")] }),
			runV3({ script: [tools(call("w", WRITE, { cliente: "A" }))] }),
			runV3({ origin: "routine", options: { ownerSteps: 1 }, params: { conversationId: undefined }, script: [read(1), say("")] }),
		]);
		const known = new Set<string>(RUN_EVENT_TYPES);
		for (const { events } of runs) {
			expect(events.length).toBeGreaterThan(0);
			for (const event of events) {
				expect(known.has(event.type)).toBe(true);
				expect(runTerminalKey(event)).toBeNull();
			}
		}
	});

	it("grava span por chamada de modelo e por tool, com a decisão da política", async () => {
		const { steps } = await runV3({ origin: "routine", script: [tools(call("r", READ, { nome: "x" }), call("w", WRITE, { cliente: "x" })), say("ok")] });
		const models = steps.filter((step) => step.type === "model");
		expect(models).toHaveLength(2);
		expect(models[0]!.telemetry).toMatchObject({ requestedModel: "m", servedModel: "m" });
		const spans = steps.filter((step) => step.type === "tool_result").map((step) => [step.telemetry?.toolName, step.telemetry?.policyDecision]);
		expect(spans).toEqual([[READ, "allow"], [WRITE, "blocked"]]);
		expect(steps.find((step) => step.subIndex === -1 || (step.type === "checkpoint" && (step.outputJson as { engine?: string } | undefined)?.engine === "v3"))).toBeDefined();
	});


});

describe("motor v3: ponte tolerante (envelope repetido, número em texto, tool não oferecida)", () => {
	it("chamada direta com {name, args} repetido executa com o objeto interno", async () => {
		const { mcpCall, results } = await runV3({ script: [tools(call("e1", READ, { name: READ, args: { nome: "Acme" } })), say("ok")] });
		expect(mcpCall).toHaveBeenCalledWith(READ, { nome: "Acme" }, expect.anything(), expect.anything());
		expect(results[0]!.ok).toBe(true);
	});

	it("via tool_call, com o nome real ou o nome normalizado, também desembrulha e converte texto numérico", async () => {
		const { mcpCall, results } = await runV3({ script: [tools(call("e2", "tool_call", { name: READ, args: { name: READ, args: { nome: "Acme", id: "48213" } } })), say("ok")] });
		expect(mcpCall).toHaveBeenCalledWith(READ, { nome: "Acme", id: 48213 }, expect.anything(), expect.anything());
		expect(results[0]!.ok).toBe(true);
	});

	it("envelope com outro nome é erro com a assinatura (não adivinha)", async () => {
		const { mcpCall, results } = await runV3({ script: [tools(call("e3", READ, { name: WRITE, args: { nome: "Acme" } })), say("ok")] });
		expect(mcpCall).not.toHaveBeenCalled();
		expect(results[0]!.ok).toBe(false);
		expect(results[0]!.summary).toMatch(/tool_call envelope[\s\S]*Expected: mcp__erp__buscar_cliente\(nome\?: string, id\?: number\)/);
	});

	it("texto numérico vira número na chamada direta; texto não numérico segue como veio (o erro é do executor)", async () => {
		const { mcpCall } = await runV3({ script: [tools(call("n1", READ, { nome: "x", id: " 42 " }), call("n2", READ, { nome: "y", id: "4x" })), say("ok")] });
		expect(mcpCall).toHaveBeenNthCalledWith(1, READ, { nome: "x", id: 42 }, expect.anything(), expect.anything());
		expect(mcpCall).toHaveBeenNthCalledWith(2, READ, { nome: "y", id: "4x" }, expect.anything(), expect.anything());
	});

	it("tool que existe no sistema mas não é oferecida no run diz \"not offered in this run\"", async () => {
		const { results } = await runV3({ script: [tools(call("o1", "sandbox_shell", { command: "ls" })), say("ok")] });
		expect(results[0]!.ok).toBe(false);
		expect(results[0]!.summary).toMatch(/^Tool "sandbox_shell" is not offered in this run\./);
	});
});

describe("motor v3: array mandado como texto JSON (PR8e)", () => {
	const listing = {
		id: "conn-erp",
		slug: "erp",
		name: "ERP",
		disabledTools: [],
		tools: [
			{
				name: "conferir_itens",
				description: "Confere itens",
				inputSchema: { type: "object", properties: { itens: { type: "array", items: { type: "object", properties: { sku: { type: "string" }, qtd: { type: "integer" } }, required: ["sku"] } } }, required: ["itens"] },
				annotations: { readOnlyHint: true },
			},
		],
	};
	const TOOL = "mcp__erp__conferir_itens";
	const mcpWith = (callFn: ReturnType<typeof vi.fn>) => ({ toolset: buildMcpToolset([listing], { autonomy: balanced }), call: callFn }) as unknown as McpRuntime;

	it("texto JSON válido chega ao conector como array, uma vez, e o modelo recebe a nota", async () => {
		const mcpCall = vi.fn(async () => ({ ok: true, text: "2 itens ok", truncated: false }));
		const itens = [{ sku: "A1", qtd: 2 }, { sku: "B2" }];
		const { results, requests } = await runV3({ script: [tools(call("c1", TOOL, { itens: JSON.stringify(itens) })), say("Conferido.")], params: { mcp: mcpWith(mcpCall) } });
		expect(mcpCall).toHaveBeenCalledTimes(1);
		expect(mcpCall.mock.calls[0]![1]).toEqual({ itens });
		expect(results[0]).toMatchObject({ name: TOOL, ok: true });
		// A nota vai ao modelo junto do resultado da tool.
		expect(requests[1]!.texts.at(-1)).toMatch(/2 itens ok[\s\S]*Note: itens arrived as JSON text and was converted/);
	});

	it("texto que parece JSON mas é inválido: falha com a dica e o formato dos itens, sem chamar o conector", async () => {
		const mcpCall = vi.fn(async () => ({ ok: true, text: "x", truncated: false }));
		const { results } = await runV3({ script: [tools(call("c1", TOOL, { itens: '[{"sku": "A1"' })), say("Não deu.")], params: { mcp: mcpWith(mcpCall) } });
		expect(mcpCall).not.toHaveBeenCalled();
		expect(results[0]).toMatchObject({ name: TOOL, ok: false });
		expect(results[0]!.summary).toMatch(/itens must be a JSON array, not text[\s\S]*shapes \(send real JSON arrays\/objects, not text\): itens: \{sku: string, qtd\?: number\}\[\]/);
	});
});
