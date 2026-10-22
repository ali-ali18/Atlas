import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsResult } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { saveSkillPendingIntent } from "@workspace/db";
import type { LessonRule } from "@workspace/shared";
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
			inputSchema: { type: "object", properties: { cliente: { type: "string" }, pagamento: { type: "string" } } },
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
		},
		{ name: "listar_pagamentos", description: "Lista formas de pagamento", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
	],
};

const CREATE = "mcp__erp__criar_proposta";
const LIST = "mcp__erp__listar_pagamentos";

let seq = 0;
const calls = (...items: Array<[string, unknown]>): CompleteChatWithToolsResult => ({
	model: "m",
	message: { role: "assistant", content: null, tool_calls: items.map(([name, args]) => ({ id: `c${++seq}`, type: "function" as const, function: { name, arguments: JSON.stringify(args) } })) },
	finishReason: "tool_calls",
});
const say = (text: string): CompleteChatWithToolsResult => ({ model: "m", message: { role: "assistant", content: text }, finishReason: "stop" });

const lessonWith = (rule: LessonRule, over: Record<string, unknown> = {}) => ({
	id: "cl0000lessonabcd",
	scope: "bot" as const,
	scopeKey: null,
	content: "Ao criar proposta, siga a regra — porque o ERP exige",
	helpful: 0,
	harmful: 0,
	rule,
	...over,
});

async function run(input: { rules: ReturnType<typeof lessonWith>[]; script: CompleteChatWithToolsResult[]; autonomy?: "balanced" | "autonomous" }) {
	const level = input.autonomy ?? "autonomous";
	const call = vi.fn(async () => ({ ok: true, text: "feito", truncated: false }));
	const mcp: McpRuntime = { toolset: buildMcpToolset([erp], { autonomy: { level, exceptions: [] } }), call };
	const events: Array<Record<string, unknown> & { type: string }> = [];
	const inspect: Array<Record<string, unknown>> = [];
	const recordFeedback = vi.fn(async () => ({ applied: [], unknown: [], retired: [] }));
	const queue = [...input.script];
	await runComputerUse({
		manager: {} as SandboxManager,
		getSessionId: async () => { throw new Error("nao deve criar sessao"); },
		sandboxEnabled: false,
		model: "m",
		apiKey: "test",
		messages: [{ role: "user", content: "crie a proposta" }],
		botId: "bot-1",
		userId: "user-1",
		conversationId: "conv-hooks",
		runId: "runhooks1",
		origin: "chat",
		maxSteps: 8,
		mcp,
		autonomy: { level, exceptions: [] },
		lessons: { items: input.rules, recordFeedback },
		onInspect: (payload) => { inspect.push(payload as never); },
		onEvent: (event) => { events.push(event as never); },
		streamChat: async () => {
			const next = queue.shift();
			if (!next) throw new Error("LLM extra");
			return next;
		},
	});
	return { call, events, inspect, recordFeedback, results: events.filter((e) => e.type === "tool_result") as Array<{ ok?: boolean; summary?: string; name?: string }> };
}

describe("hooks: required_args", () => {
	beforeEach(() => { vi.clearAllMocks(); });
	const rule: LessonRule = { kind: "required_args", tool: CREATE, fields: ["pagamento"], note: "o ERP recusa sem pagamento" };

	it("campo ausente: erro com o id da licao, sem executar e sem cartao", async () => {
		const { call, results, events, inspect } = await run({ rules: [lessonWith(rule)], script: [calls([CREATE, { cliente: "Acme" }]), say("falta o pagamento")] });
		expect(call).not.toHaveBeenCalled();
		expect(events.some((e) => e.type === "confirm")).toBe(false);
		expect(saveSkillPendingIntent).not.toHaveBeenCalled();
		expect(results[0]?.ok).toBe(false);
		expect(results[0]?.summary).toContain("[Labcd]");
		expect(results[0]?.summary).toContain("pagamento");
		expect(inspect[0]).toMatchObject({ type: "inspect_hooks", hits: [{ source: "rule", action: "blocked", ref: "Labcd", ruleKind: "required_args" }] });
	});

	it("com o campo preenchido a chamada segue o fluxo normal", async () => {
		const { call, results } = await run({ rules: [lessonWith(rule)], script: [calls([CREATE, { cliente: "Acme", pagamento: "pix" }]), say("pronto")] });
		expect(call).toHaveBeenCalledTimes(1);
		expect(results[0]?.ok).toBe(true);
	});

	it("quando a regra barra e a chamada seguinte da certo, a licao ganha 'ajudou'", async () => {
		const { recordFeedback, inspect } = await run({
			rules: [lessonWith(rule)],
			script: [calls([CREATE, { cliente: "Acme" }]), calls([CREATE, { cliente: "Acme", pagamento: "pix" }]), say("pronto")],
		});
		expect(recordFeedback).toHaveBeenCalledWith([{ ref: "Labcd", outcome: "helped" }]);
		expect(inspect).toContainEqual({ type: "inspect_hooks", helped: ["cl0000lessonabcd"] });
	});

	it("sem barrar antes, nao ha contagem", async () => {
		const { recordFeedback } = await run({ rules: [lessonWith(rule)], script: [calls([CREATE, { cliente: "Acme", pagamento: "pix" }]), say("pronto")] });
		expect(recordFeedback).not.toHaveBeenCalled();
	});
});

describe("hooks: require_prior_call", () => {
	beforeEach(() => { vi.clearAllMocks(); });
	const rule: LessonRule = { kind: "require_prior_call", tool: CREATE, requires: LIST, within: "run" };

	it("sem a leitura previa o erro diz qual chamada falta; depois dela a escrita passa", async () => {
		const { call, results } = await run({
			rules: [lessonWith(rule)],
			script: [calls([CREATE, { cliente: "Acme", pagamento: "pix" }]), calls([LIST, {}]), calls([CREATE, { cliente: "Acme", pagamento: "pix" }]), say("pronto")],
		});
		expect(results[0]?.ok).toBe(false);
		expect(results[0]?.summary).toContain(LIST);
		expect(results[1]?.ok).toBe(true);
		expect(results[2]?.ok).toBe(true);
		expect(call).toHaveBeenCalledTimes(2);
	});

	it("a leitura que falhou nao conta como chamada previa", async () => {
		const call = vi.fn(async (name: string) => (name === LIST ? { ok: false, text: "erro", truncated: false } : { ok: true, text: "feito", truncated: false }));
		const mcp: McpRuntime = { toolset: buildMcpToolset([erp], { autonomy: { level: "autonomous", exceptions: [] } }), call: call as never };
		const queue = [calls([LIST, {}]), calls([CREATE, { cliente: "Acme" }]), say("ok")];
		const events: Array<Record<string, unknown> & { type: string }> = [];
		await runComputerUse({
			manager: {} as SandboxManager, getSessionId: async () => "x", sandboxEnabled: false, model: "m", apiKey: "t",
			messages: [{ role: "user", content: "crie" }], botId: "bot-1", userId: "user-1", conversationId: "conv-hooks", runId: "runhooks2", origin: "chat", maxSteps: 6,
			mcp, autonomy: { level: "autonomous", exceptions: [] }, lessons: { items: [lessonWith(rule)] },
			onEvent: (event) => { events.push(event as never); },
			streamChat: async () => queue.shift()!,
		});
		const create = events.filter((e) => e.type === "tool_result").find((e) => (e as { name?: string }).name === CREATE) as { ok?: boolean; summary?: string };
		expect(create.ok).toBe(false);
		expect(create.summary).toContain("é preciso uma chamada bem-sucedida");
	});
});

describe("hooks: confirm_always e escopo", () => {
	beforeEach(() => { vi.clearAllMocks(); });

	it("confirm_always forca o cartao mesmo em autonomia total; nao executa antes do aval", async () => {
		const { call, events } = await run({ rules: [lessonWith({ kind: "confirm_always", tool: CREATE })], script: [calls([CREATE, { cliente: "Acme", pagamento: "pix" }])] });
		expect(call).not.toHaveBeenCalled();
		expect(events.some((e) => e.type === "confirm")).toBe(true);
		expect(saveSkillPendingIntent).toHaveBeenCalledTimes(1);
	});

	it("sem a regra, a mesma chamada em autonomia total executa direto (a regra so aperta)", async () => {
		const { call, events } = await run({ rules: [], script: [calls([CREATE, { cliente: "Acme", pagamento: "pix" }]), say("pronto")] });
		expect(call).toHaveBeenCalledTimes(1);
		expect(events.some((e) => e.type === "confirm")).toBe(false);
	});

	it("licao de outro conector nao dispara a regra", async () => {
		const { call } = await run({
			rules: [lessonWith({ kind: "required_args", tool: CREATE, fields: ["pagamento"] }, { scope: "connector", scopeKey: "mcp:outro-conector" })],
			script: [calls([CREATE, { cliente: "Acme" }]), say("pronto")],
		});
		expect(call).toHaveBeenCalledTimes(1);
	});

	it("licao sem regra nao muda nada", async () => {
		const { call } = await run({ rules: [{ ...lessonWith({ kind: "confirm_always", tool: CREATE }), rule: null as never }], script: [calls([CREATE, { cliente: "Acme" }]), say("pronto")] });
		expect(call).toHaveBeenCalledTimes(1);
	});
});
