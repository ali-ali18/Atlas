import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxManager } from "@workspace/sandbox";
import type { ChatTool, CompleteChatWithToolsParams, CompleteChatWithToolsResult, LlmToolCall } from "@workspace/llm";
import type { AgentRunCheckpoint, ComputerUseEvent } from "@workspace/shared";
import { runComputerUse, type RuntimeStepRecord } from "../computer-use.js";
import { toolCallIdPrefix } from "../context/transcript.js";
import { runEngineV2, type EngineV2Options } from "./run.js";

vi.mock("@workspace/db", async (original) => ({
	...(await original<typeof import("@workspace/db")>()),
	searchMemoryEntries: vi.fn(async () => []),
	getBotProfile: vi.fn(async () => ({
		description: "A bot that is already configured.",
	})),
	listBotSkills: vi.fn(async () => []),
	searchSkillVersions: vi.fn(async () => []),
	listRoutines: vi.fn(async () => []),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
	upsertTaskListCard: vi.fn(async () => undefined),
	getConversationUntrustedAt: vi.fn(async () => null),
}));

const call = (id: string, name: string, args: Record<string, unknown> = {}): LlmToolCall => ({
	id,
	type: "function",
	function: { name, arguments: JSON.stringify(args) },
});
const turn = (calls: LlmToolCall[], costUsd?: number): CompleteChatWithToolsResult => ({
	model: "m",
	message: { role: "assistant", content: null, tool_calls: calls },
	...(costUsd !== undefined
		? {
				usage: {
					promptTokens: 10,
					completionTokens: 5,
					totalTokens: 15,
					costUsd,
				},
			}
		: {}),
});
const say = (content: string, costUsd?: number): CompleteChatWithToolsResult => ({
	model: "m",
	message: { role: "assistant", content },
	finishReason: "stop",
	...(costUsd !== undefined
		? {
				usage: {
					promptTokens: 10,
					completionTokens: 5,
					totalTokens: 15,
					costUsd,
				},
			}
		: {}),
});
const taskList = (id: string, items: Array<[string, "pending" | "in_progress" | "completed"]>) =>
	call(id, "update_task_list", {
		items: items.map(([content, status]) => ({ content, status })),
	});

const ZONES = [
	"America/Sao_Paulo",
	"America/New_York",
	"America/Chicago",
	"America/Denver",
	"America/Los_Angeles",
	"America/Bogota",
	"America/Lima",
	"America/Santiago",
	"Europe/London",
	"Europe/Paris",
	"Europe/Berlin",
	"Europe/Madrid",
	"Europe/Rome",
	"Europe/Lisbon",
	"Europe/Athens",
	"Europe/Moscow",
	"Asia/Tokyo",
	"Asia/Seoul",
	"Asia/Shanghai",
	"Asia/Singapore",
	"Asia/Dubai",
	"Asia/Kolkata",
	"Asia/Bangkok",
	"Asia/Jakarta",
	"Australia/Sydney",
	"Australia/Perth",
	"Pacific/Auckland",
	"Africa/Cairo",
	"Africa/Lagos",
	"Africa/Johannesburg",
];

type Request = {
	params: CompleteChatWithToolsParams;
	system: string;
	toolNames: string[];
};

async function runV2(input: {
	messages: Array<{ role: "user" | "assistant"; content: string }>;
	script: Array<CompleteChatWithToolsResult | ((request: Request) => CompleteChatWithToolsResult)>;
	options?: Partial<EngineV2Options>;
	restoredCheckpoint?: AgentRunCheckpoint | null;
	budgetCap?: number;
	runId?: string;
	params?: Partial<Parameters<typeof runEngineV2>[0]>;
}) {
	const events: ComputerUseEvent[] = [];
	const steps: RuntimeStepRecord[] = [];
	const checkpoints: AgentRunCheckpoint[] = [];
	const requests: Request[] = [];
	const script = [...input.script];
	const manager = {} as unknown as SandboxManager;
	const result = await runEngineV2(
		{
			manager,
			getSessionId: async () => "session-1",
			apiKey: "test",
			model: "m",
			runId: input.runId ?? "run-v2",
			userId: "user-a",
			botId: "bot-a",
			conversationId: "conv-1",
			origin: "chat",
			messages: input.messages,
			timeZone: "America/Sao_Paulo",
			...input.params,
			...(input.budgetCap ? { budget: { maxCostUsd: input.budgetCap } } : {}),
			...(input.restoredCheckpoint ? { restoredCheckpoint: input.restoredCheckpoint } : {}),
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
					system: params.messages
						.filter((m) => m.role === "system")
						.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
						.join("\n"),
					toolNames: params.tools.map((tool: ChatTool) => tool.function.name),
				};
				requests.push(request);
				const next = script.shift();
				if (!next) throw new Error("roteiro do modelo acabou");
				const reply = typeof next === "function" ? next(request) : next;
				if (reply.message.content) handlers?.onDelta?.(reply.message.content);
				return reply;
			},
		},
		{ profile: "chat", ...input.options },
	);
	const toolResults = events.filter((event): event is Extract<ComputerUseEvent, { type: "tool_result" }> => event.type === "tool_result");
	return { result, events, steps, checkpoints, requests, toolResults };
}

const toolMessages = (request: Request) =>
	request.params.messages
		.filter((message) => message.role === "tool")
		.map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)));

beforeEach(() => vi.clearAllMocks());

describe("motor v2: laço", () => {
	it("pesquisa com 30 leituras NÃO é cortada no passo 24 nem por estagnação, e termina com entrega", async () => {
		// Diferença central para o v1: teto soft de 24 passos, estagnação e stall-guard encerravam este run.
		const script: Array<CompleteChatWithToolsResult> = [
			turn([call("s0", "mcp_tool_search", { query: "current_time" })]),
			turn([
				taskList("t0", [
					["Levantar horários", "in_progress"],
					["Consolidar", "pending"],
				]),
			]),
			...ZONES.map((zone, index) => turn([call(`r${index}`, "current_time", { timezone: zone })])),
			turn([
				taskList("t1", [
					["Levantar horários", "completed"],
					["Consolidar", "completed"],
				]),
			]),
			say("Entrega final com fontes e suposições."),
		];
		const { result, toolResults, requests, events } = await runV2({
			messages: [
				{
					role: "user",
					content: "Faça uma pesquisa de mercado dos horários e monte um relatório",
				},
			],
			script,
			options: { profile: "long_work" },
		});
		expect(result.text).toBe("Entrega final com fontes e suposições.");
		expect(result.stop).toEqual({ reason: "answered" });
		expect(toolResults.filter((r) => r.name === "current_time" && r.ok)).toHaveLength(30);
		expect(requests.length).toBeGreaterThan(24);
		// Nenhuma chamada foi feita sem tools por trava, e nenhuma tool foi tirada no meio do trabalho.
		expect(requests.every((request) => request.params.toolChoice !== "none")).toBe(true);
		expect(requests.at(-1)!.toolNames).toContain("current_time");
		expect(events.some((event) => event.type === "assistant_discard")).toBe(false);
		expect(result.hitWall).toBe(false);
	});

	it("'Bom dia' no v2 continua barato: 1 chamada, prompt pequeno e sem as tools raras", async () => {
		const v2 = await runV2({
			messages: [{ role: "user", content: "Bom dia" }],
			script: [say("Bom dia!")],
		});
		expect(v2.requests).toHaveLength(1);
		expect(v2.result.text).toBe("Bom dia!");
		expect(v2.result.stop).toEqual({ reason: "answered" });
		const first = v2.requests[0]!;
		// Catálogo curto: o navegador, o shell e os painéis ficam adiados atrás do índice.
		for (const rare of ["navigate", "sandbox_shell", "page_create", "list_routines", "current_time"]) expect(first.toolNames).not.toContain(rare);
		expect(first.toolNames).toContain("mcp_tool_search");
		expect(first.toolNames).toContain("web_search");
		expect(first.system).toMatch(/Built-in tools loaded on demand/);

		// Comparação com o v1 no mesmo pedido: o v2 não pode ficar mais caro na conversa curta.
		const v1Requests: Request[] = [];
		await runComputerUse({
			manager: {} as unknown as SandboxManager,
			getSessionId: async () => "session-1",
			apiKey: "test",
			model: "m",
			runId: "run-v1",
			userId: "user-a",
			botId: "bot-a",
			origin: "chat",
			contextEconomy: true,
			messages: [{ role: "user", content: "Bom dia" }],
			maxSteps: 6,
			onEvent: () => undefined,
			streamChat: async (params) => {
				v1Requests.push({
					params,
					system: params.messages
						.filter((m) => m.role === "system")
						.map((m) => String(m.content))
						.join("\n"),
					toolNames: params.tools.map((tool: ChatTool) => tool.function.name),
				});
				return say("Bom dia!");
			},
		});
		const size = (request: Request) => JSON.stringify(request.params.tools).length + request.system.length;
		expect(size(first)).toBeLessThanOrEqual(size(v1Requests[0]!));
	});

	it("emite os eventos do contrato (mesmo id em tool_call/tool_result, task_list) e grava passos e checkpoints", async () => {
		const { result, events, steps, checkpoints } = await runV2({
			messages: [{ role: "user", content: "Monte um relatório rápido das horas" }],
			script: [turn([call("a1", "mcp_tool_search", { query: "current_time" })]), turn([call("a2", "current_time", { timezone: "Asia/Tokyo" })]), say("Pronto.")],
			options: { profile: "chat" },
		});
		expect(result.stop).toEqual({ reason: "answered" });
		const calls = events.filter((event): event is Extract<ComputerUseEvent, { type: "tool_call" }> => event.type === "tool_call");
		const results = events.filter((event): event is Extract<ComputerUseEvent, { type: "tool_result" }> => event.type === "tool_result");
		expect(calls.map((event) => event.name)).toEqual(["mcp_tool_search", "current_time"]);
		expect(results.map((event) => event.id)).toEqual(calls.map((event) => event.id));
		// Ids com o prefixo do run (estável ao vivo e persistido).
		expect(calls[0]!.id.startsWith(toolCallIdPrefix("run-v2"))).toBe(true);
		expect(events.some((event) => event.type === "assistant_delta" && event.delta === "Pronto.")).toBe(true);
		expect(steps.filter((step) => step.type === "model")).toHaveLength(3);
		expect(steps.filter((step) => step.type === "tool")).toHaveLength(2);
		expect(steps.filter((step) => step.type === "tool_result").every((step) => step.status === "completed")).toBe(true);
		expect(steps.some((step) => step.subIndex === 98 && (step.outputJson as { engine?: string }).engine === "v2")).toBe(true);
		const last = checkpoints.at(-1)!;
		expect(last.llmMessages?.length).toBeGreaterThan(3);
		expect(last.nextStepIndex).toBeGreaterThanOrEqual(2);
	});

	it("a retomada continua do checkpoint (histórico, passo e uso acumulados)", async () => {
		const first = await runV2({
			messages: [{ role: "user", content: "Quero um relatório" }],
			script: [
				turn([call("c1", "mcp_tool_search", { query: "current_time" })], 0.01),
				turn([call("c2", "current_time", { timezone: "Asia/Tokyo" })], 0.01),
				say("ok", 0.01),
			],
		});
		// Checkpoint do começo do 3º passo: as duas tools já têm resultado, o modelo ainda não respondeu.
		const saved = first.checkpoints.find((checkpoint) => (checkpoint.nextStepIndex ?? 0) === 2)!;
		expect(saved).toBeDefined();
		const resumed = await runV2({
			messages: [{ role: "user", content: "Quero um relatório" }],
			script: [say("Retomado e entregue.", 0.01)],
			restoredCheckpoint: saved,
		});
		expect(resumed.result.text).toBe("Retomado e entregue.");
		// O histórico anterior (resultado da tool) segue no pedido e o custo acumulado continua.
		expect(toolMessages(resumed.requests[0]!).some((text) => text.includes("Asia/Tokyo"))).toBe(true);
		expect(resumed.result.usage.costUsd).toBeCloseTo(0.03, 5);
	});
});

describe("motor v2: Supervisor no laço", () => {
	it("avisa UMA vez a 80% e, ao estourar, faz a última chamada SEM tools e entrega", async () => {
		const { result, requests } = await runV2({
			messages: [{ role: "user", content: "Confira a hora em Tóquio e em Seul" }],
			script: [
				turn([call("m0", "mcp_tool_search", { query: "current_time" })], 0.045),
				turn([call("m1", "current_time", { timezone: "Asia/Tokyo" })], 0.045),
				turn([call("m2", "current_time", { timezone: "Asia/Seoul" })], 0.03),
				say("Entrega com o que deu para levantar.", 0.01),
			],
			options: { profile: "long_work", longWorkBudgetUsd: 0.1 },
		});
		// Custo: 0.045 + 0.045 = 0.09 (90%) -> nota no 3º passo; +0.03 = 0.12 (>= 100%) -> entrega sem tools.
		const noted = requests.map((request) => toolMessages(request).filter((text) => text.includes("Budget notice")).length);
		expect(noted).toEqual([0, 0, 1, 1]);
		expect(requests).toHaveLength(4);
		expect(requests[3]!.params.toolChoice).toBe("none");
		expect(requests.slice(0, 3).every((request) => request.params.toolChoice === "auto")).toBe(true);
		expect(result.text).toBe("Entrega com o que deu para levantar.");
		expect(result.stop).toEqual({ reason: "budget_cost", detail: "delivered" });
	});

	it("o teto de custo da conta vale mais que o orçamento do perfil", async () => {
		const { result, requests } = await runV2({
			messages: [{ role: "user", content: "oi" }],
			script: [turn([call("x0", "mcp_tool_search", { query: "current_time" })], 0.06), say("Fechei.")],
			options: { profile: "long_work", longWorkBudgetUsd: 5 },
			budgetCap: 0.05,
		});
		expect(requests[1]!.params.toolChoice).toBe("none");
		expect(result.stop?.reason).toBe("budget_cost");
	});

	it("mesma tool + mesmos args + mesmo resultado 3x vira nota; só a reincidência encerra (com entrega)", async () => {
		// Relógio fixo: o resultado de current_time traz os segundos e precisa ser igual nas 4 chamadas.
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-11-01T12:00:00Z"));
		const same = (id: string) => turn([call(id, "current_time", { timezone: "Asia/Tokyo" })]);
		const outcome = await runV2({
			messages: [{ role: "user", content: "oi" }],
			script: [
				turn([call("l0", "mcp_tool_search", { query: "current_time" })]),
				same("l1"),
				same("l2"),
				same("l3"),
				same("l4"),
				say("Parei de repetir; resultado parcial."),
			],
		});
		vi.useRealTimers();
		const { result, requests, toolResults } = outcome;
		const notes = requests.flatMap((request) => toolMessages(request)).filter((text) => text.includes("Loop notice"));
		expect(notes.length).toBeGreaterThanOrEqual(1);
		expect(result.stop).toEqual({ reason: "loop_repeat", detail: "after_note" });
		expect(requests.at(-1)!.params.toolChoice).toBe("none");
		expect(result.text).toBe("Parei de repetir; resultado parcial.");
		expect(toolResults.filter((r) => r.name === "current_time")).toHaveLength(4);
	});

	it("falhas seguidas da mesma tool: nota e bloqueio temporário, sem matar o run", async () => {
		const bad = (id: string) => turn([call(id, "current_time", { timezone: "Nao/Existe" })]);
		const { result, toolResults, requests } = await runV2({
			messages: [{ role: "user", content: "oi" }],
			script: [turn([call("f0", "mcp_tool_search", { query: "current_time" })]), bad("f1"), bad("f2"), bad("f3"), bad("f4"), say("Sigo sem essa ferramenta.")],
		});
		expect(result.stop).toEqual({ reason: "answered" });
		const failed = toolResults.filter((r) => r.name === "current_time");
		expect(failed.map((r) => r.ok)).toEqual([false, false, false, false]);
		// A 4ª chamada já encontrou a tool bloqueada (não executou).
		expect(failed[3]!.summary).toMatch(/temporarily unavailable/);
		expect(requests.flatMap((request) => toolMessages(request)).some((text) => text.includes("Tool notice"))).toBe(true);
	});
});

describe("motor v2: lista de tarefas em trabalho longo", () => {
	it("responder sem lista ou com itens abertos recebe nota; depois de 2 notas sai e marca no stop", async () => {
		const { result, requests, events } = await runV2({
			messages: [
				{
					role: "user",
					content: "Faça uma pesquisa de mercado completa e monte um relatório",
				},
			],
			script: [
				say("Rascunho sem lista."),
				turn([
					taskList("k1", [
						["Pesquisar concorrentes", "in_progress"],
						["Conferir preços", "pending"],
					]),
				]),
				say("Entrego sem conferir."),
				say("Entrego mesmo assim."),
				say("Entrega final."),
			],
			options: { profile: "long_work" },
		});
		const notes = requests
			.flatMap((request) => request.params.messages.filter((m) => m.role === "user").map((m) => String(typeof m.content === "string" ? m.content : "")))
			.filter((text) => text.includes("Task list"));
		expect(notes.some((text) => text.includes("Task list required"))).toBe(true);
		expect(notes.some((text) => text.includes("Task list still has open items"))).toBe(true);
		expect(events.filter((event) => event.type === "assistant_discard")).toHaveLength(2);
		// 2 notas gastas (sem lista + itens abertos): a 3ª tentativa de entrega passa.
		expect(result.stop).toEqual({ reason: "answered", detail: "tasklist_open" });
		expect(result.text).toContain("Entrego mesmo assim.");
		expect(result.text).toContain("Não deu para confirmar: Pesquisar concorrentes");
		expect(result.text).toContain("Não deu para confirmar: Conferir preços");
	});

	it("itens descartados com motivo liberam a entrega e aparecem como 'não deu para confirmar'", async () => {
		const { result, events } = await runV2({
			messages: [
				{
					role: "user",
					content: "Faça uma pesquisa de mercado completa e monte um relatório",
				},
			],
			script: [
				turn([
					taskList("d1", [
						["Pesquisar concorrentes", "completed"],
						["DROPPED: o site exige login", "completed"],
					]),
				]),
				say("Aqui está o relatório."),
			],
			options: { profile: "long_work" },
		});
		expect(result.stop).toEqual({ reason: "answered" });
		expect(result.text).toBe("Aqui está o relatório.\n\n- Não deu para confirmar: o site exige login");
		// O balão ao vivo recebe o mesmo acréscimo.
		const deltas = events
			.filter((event): event is Extract<ComputerUseEvent, { type: "assistant_delta" }> => event.type === "assistant_delta")
			.map((event) => event.delta)
			.join("");
		expect(deltas).toContain("Não deu para confirmar: o site exige login");
	});

	it("no perfil chat a lista não é exigida", async () => {
		const { result } = await runV2({
			messages: [{ role: "user", content: "oi" }],
			script: [say("Oi!")],
			options: { profile: "chat" },
		});
		expect(result.stop).toEqual({ reason: "answered" });
	});
});

describe("motor v2: nível de raciocínio", () => {
	const messages = [{ role: "user" as const, content: "oi" }];
	it("repassa o nível ao modelo com suporte e não manda a modelo sem suporte", async () => {
		const withSupport = await runV2({ messages, script: [say("oi")], params: { model: "anthropic/claude-sonnet-5.5", reasoningEffort: "low", modelSupportsReasoning: () => true } });
		expect(withSupport.requests.every((request) => request.params.reasoningEffort === "low")).toBe(true);
		const without = await runV2({ messages, script: [say("oi")], params: { model: "openai/gpt-4o", reasoningEffort: "low", modelSupportsReasoning: () => false } });
		expect(without.requests.every((request) => !("reasoningEffort" in request.params))).toBe(true);
	});
	it("sem escolha, nada vai (padrão do modelo)", async () => {
		const { requests } = await runV2({ messages, script: [say("oi")] });
		expect(requests.every((request) => !("reasoningEffort" in request.params))).toBe(true);
	});
});
