import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsResult } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { persistConversationCardFromEvent, saveSkillPendingIntent } from "@workspace/db";
import { PLAN_PENDING_RESULT } from "@workspace/shared";
import { buildMcpToolset } from "./mcp/registry.js";
import type { McpRuntime } from "./mcp/runtime.js";
import { runComputerUse } from "./computer-use.js";

vi.mock("@workspace/db", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@workspace/db")>();
	return {
		...actual,
		getBotProfile: vi.fn(async () => null),
		saveSkillPendingIntent: vi.fn(async () => undefined),
		findExecutedConfirmCall: vi.fn(async () => null),
		persistJevStatusCard: vi.fn(async () => undefined),
		persistConversationCardFromEvent: vi.fn(async () => undefined),
		upsertTaskListCard: vi.fn(async () => undefined),
		searchMemoryEntries: vi.fn(async () => []),
		listBotSkills: vi.fn(async () => []),
		searchSkillVersions: vi.fn(async () => []),
		listRoutines: vi.fn(async () => []),
		loadAutonomyContext: vi.fn(async () => ({ accountRaw: null, botRaw: null, botName: "Taldo" })),
	};
});

const erp = {
	id: "conn-erp",
	slug: "erp",
	name: "ERP",
	disabledTools: [],
	tools: [
		{
			name: "criar_proposta",
			description: "Cria proposta",
			inputSchema: { type: "object", required: ["cliente"], properties: { cliente: { type: "string" } } },
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
		},
		{ name: "listar", description: "Lista", inputSchema: { type: "object", properties: { q: { type: "string" } } }, annotations: { readOnlyHint: true } },
	],
};

const PLAN_ARGS = {
	title: "Criar propostas dos pedidos abertos",
	steps: [
		{ text: "Listar pedidos abertos", kind: "read" },
		{ text: "Criar a proposta de cada pedido", kind: "write" },
	],
	needs: ["Forma de pagamento"],
	risks: "Proposta criada nao se desfaz",
};

let seq = 0;
const calls = (...items: Array<[string, unknown]>): CompleteChatWithToolsResult => ({
	model: "m",
	message: { role: "assistant", content: null, tool_calls: items.map(([name, args]) => ({ id: `c${++seq}`, type: "function" as const, function: { name, arguments: JSON.stringify(args) } })) },
	finishReason: "tool_calls",
});
const say = (text: string): CompleteChatWithToolsResult => ({ model: "m", message: { role: "assistant", content: text }, finishReason: "stop" });

async function run(input: { script: CompleteChatWithToolsResult[]; origin?: string; planMode?: boolean; planPending?: boolean }) {
	const call = vi.fn(async () => ({ ok: true, text: "feito", truncated: false }));
	const mcp: McpRuntime = { toolset: buildMcpToolset([erp], { autonomy: { level: "autonomous", exceptions: [] } }), call };
	const requests: Array<{ tools: string[] }> = [];
	const events: Array<Record<string, unknown> & { type: string }> = [];
	const inspect: Array<Record<string, unknown>> = [];
	const queue = [...input.script];
	await runComputerUse({
		manager: {} as SandboxManager,
		getSessionId: async () => { throw new Error("nao deve criar sessao"); },
		sandboxEnabled: false,
		model: "m",
		apiKey: "test",
		messages: [{ role: "user", content: "crie as propostas de todos os pedidos abertos" }],
		botId: "bot-1",
		userId: "user-1",
		conversationId: "conv-plan",
		runId: "runplan1",
		origin: input.origin ?? "chat",
		maxSteps: 6,
		mcp,
		autonomy: { level: "autonomous", exceptions: [] },
		planMode: input.planMode,
		planPending: input.planPending,
		onInspect: (payload) => { inspect.push(payload as never); },
		onEvent: (event) => { events.push(event as never); },
		streamChat: async (params) => {
			requests.push({ tools: params.tools.map((tool) => tool.function.name) });
			const next = queue.shift();
			if (!next) throw new Error("LLM extra");
			return next;
		},
	});
	return { call, requests, events, inspect, results: events.filter((e) => e.type === "tool_result") as Array<{ ok?: boolean; summary?: string; name?: string }> };
}

describe("propose_plan: exposicao", () => {
	beforeEach(() => { vi.clearAllMocks(); });

	it("e tool do nucleo no chat; some em rotina e com o ajuste do bot desligado", async () => {
		expect((await run({ script: [say("ok")] })).requests[0]!.tools).toContain("propose_plan");
		expect((await run({ script: [say("ok")], origin: "routine" })).requests[0]!.tools).not.toContain("propose_plan");
		expect((await run({ script: [say("ok")], planMode: false })).requests[0]!.tools).not.toContain("propose_plan");
		expect((await run({ script: [say("ok")], planMode: true })).requests[0]!.tools).toContain("propose_plan");
	});
});

describe("propose_plan: cartao e parada", () => {
	beforeEach(() => { vi.clearAllMocks(); });

	it("grava a intencao pendente, persiste o cartao com o plano e para o run no cartao", async () => {
		const { events, requests, inspect } = await run({ script: [calls(["propose_plan", PLAN_ARGS])] });
		expect(requests).toHaveLength(1);
		const card = events.find((e) => e.type === "confirm") as { confirmId: string; confirmLabel: string; plan: { steps: unknown[]; needs: string[] } } | undefined;
		expect(card?.confirmId).toBe("confirm-plan-runplan1");
		expect(card?.confirmLabel).toBe("Aprovar plano");
		expect(card?.plan.steps).toHaveLength(2);
		expect(card?.plan.needs).toEqual(["Forma de pagamento"]);
		expect(saveSkillPendingIntent).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "conv-plan", payload: expect.objectContaining({ kind: "confirm", action: "plan", confirmId: "confirm-plan-runplan1", plan: expect.objectContaining({ title: PLAN_ARGS.title }) }) }));
		expect(persistConversationCardFromEvent).toHaveBeenCalledWith("conv-plan", expect.objectContaining({ confirmId: "confirm-plan-runplan1", plan: expect.anything() }));
		const result = events.find((e) => e.type === "tool_result") as { summary: string };
		expect(result.summary.startsWith(PLAN_PENDING_RESULT)).toBe(true);
		expect(inspect).toContainEqual({ type: "inspect_hooks", plan: { status: "proposed", title: PLAN_ARGS.title } });
	});

	it("plano invalido volta como erro da tool, sem cartao", async () => {
		const { events, results } = await run({ script: [calls(["propose_plan", { title: "x", steps: [] }]), say("ok")] });
		expect(events.some((e) => e.type === "confirm")).toBe(false);
		expect(results[0]?.ok).toBe(false);
		expect(saveSkillPendingIntent).not.toHaveBeenCalled();
	});
});

describe("plano pendente: escritas bloqueadas, leituras livres", () => {
	beforeEach(() => { vi.clearAllMocks(); });

	it("com plano pendente na conversa, escrita volta com erro e nao executa; leitura executa", async () => {
		const { call, results } = await run({
			planPending: true,
			script: [calls(["mcp__erp__criar_proposta", { cliente: "Acme" }], ["mcp__erp__listar", { q: "abertos" }]), say("preciso do plano aprovado")],
		});
		const write = results.find((r) => r.name === "mcp__erp__criar_proposta");
		expect(write?.ok).toBe(false);
		expect(write?.summary).toContain("plano aguardando aprovação");
		const read = results.find((r) => r.name === "mcp__erp__listar");
		expect(read?.ok).toBe(true);
		expect(call).toHaveBeenCalledTimes(1);
	});

	it("escrita no mesmo lote do propose_plan nao roda (o run para no cartao)", async () => {
		const { call, events } = await run({ script: [calls(["propose_plan", PLAN_ARGS], ["mcp__erp__criar_proposta", { cliente: "Acme" }])] });
		expect(events.some((e) => e.type === "confirm")).toBe(true);
		expect(call).not.toHaveBeenCalled();
	});

	it("escrita ANTES do propose_plan no mesmo lote tambem e barrada (o portao liga com o lote)", async () => {
		const { call, results } = await run({ script: [calls(["mcp__erp__criar_proposta", { cliente: "Acme" }], ["propose_plan", PLAN_ARGS])] });
		expect(call).not.toHaveBeenCalled();
		expect(results.find((r) => r.name === "mcp__erp__criar_proposta")?.summary).toContain("plano aguardando aprovação");
	});

	it("plano invalido nao deixa o portao ligado: a escrita seguinte executa", async () => {
		const { call } = await run({ script: [calls(["propose_plan", { title: "x", steps: [] }]), calls(["mcp__erp__criar_proposta", { cliente: "Acme" }]), say("pronto")] });
		expect(call).toHaveBeenCalledTimes(1);
	});

	it("sem plano pendente a escrita segue o fluxo normal", async () => {
		const { call, results } = await run({ script: [calls(["mcp__erp__criar_proposta", { cliente: "Acme" }]), say("pronto")] });
		expect(results[0]?.ok).toBe(true);
		expect(call).toHaveBeenCalledTimes(1);
	});
});
