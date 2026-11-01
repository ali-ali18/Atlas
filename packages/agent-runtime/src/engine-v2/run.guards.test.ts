import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsResult, LlmToolCall } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import { saveSkillPendingIntent } from "@workspace/db";
import type { ComputerUseEvent, LessonRule } from "@workspace/shared";
import { buildMcpToolset } from "../mcp/registry.js";
import type { McpRuntime } from "../mcp/runtime.js";
import { LeaseLostError } from "../errors.js";
import { runEngineV2, type EngineV2Options } from "./run.js";
import { dedupeLoginAsk } from "./login.js";

vi.mock("@workspace/db", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@workspace/db")>();
	return {
		...actual,
		getBotProfile: vi.fn(async () => ({ description: "configurado" })),
		saveSkillPendingIntent: vi.fn(async () => undefined),
		findExecutedConfirmCall: vi.fn(async () => null),
		persistJevStatusCard: vi.fn(async () => undefined),
		persistConversationCardFromEvent: vi.fn(async () => undefined),
		upsertTaskListCard: vi.fn(async () => undefined),
		getConversationUntrustedAt: vi.fn(async () => null),
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
	],
};
const CREATE = "mcp__erp__criar_proposta";

let seq = 0;
const calls = (item: [string, unknown], usage?: { promptTokens: number; completionTokens: number; costUsd?: number }): CompleteChatWithToolsResult => ({
	model: "m",
	message: {
		role: "assistant",
		content: null,
		tool_calls: [{ id: `g${++seq}`, type: "function", function: { name: item[0], arguments: JSON.stringify(item[1]) } } satisfies LlmToolCall],
	},
	finishReason: "tool_calls",
	...(usage ? { usage: { ...usage, totalTokens: usage.promptTokens + usage.completionTokens } } : {}),
});
const say = (text: string): CompleteChatWithToolsResult => ({ model: "m", message: { role: "assistant", content: text }, finishReason: "stop" });
const lessonWith = (rule: LessonRule) => ({ id: "cl0000lessonabcd", scope: "bot" as const, scopeKey: null, content: "regra", helpful: 0, harmful: 0, rule });

async function run(input: {
	script: Array<CompleteChatWithToolsResult | (() => CompleteChatWithToolsResult)>;
	options?: Partial<EngineV2Options>;
	lessons?: ReturnType<typeof lessonWith>[];
	planPending?: boolean;
	extra?: Partial<Parameters<typeof runEngineV2>[0]>;
}) {
	const call = vi.fn(async () => ({ ok: true, text: "feito", truncated: false }));
	const mcp: McpRuntime = { toolset: buildMcpToolset([erp], { autonomy: { level: "autonomous", exceptions: [] } }), call };
	const events: ComputerUseEvent[] = [];
	const queue = [...input.script];
	const requests: Array<{ toolChoice?: string }> = [];
	const result = await runEngineV2(
		{
			manager: {} as SandboxManager,
			getSessionId: async () => "x",
			sandboxEnabled: false,
			model: "m",
			apiKey: "t",
			messages: [{ role: "user", content: "crie a proposta" }],
			botId: "bot-1",
			userId: "user-1",
			conversationId: "conv-g",
			runId: "rungd1",
			origin: "chat",
			mcp,
			autonomy: { level: "autonomous", exceptions: [] },
			...(input.lessons ? { lessons: { items: input.lessons } } : {}),
			...(input.planPending ? { planPending: true } : {}),
			onEvent: (event) => {
				events.push(event);
			},
			streamChat: async (params) => {
				requests.push({ toolChoice: params.toolChoice });
				const next = queue.shift();
				if (!next) throw new Error("LLM extra");
				return typeof next === "function" ? next() : next;
			},
			...input.extra,
		},
		{ profile: "chat", ...input.options },
	);
	return { call, events, result, requests, results: events.filter((e): e is Extract<ComputerUseEvent, { type: "tool_result" }> => e.type === "tool_result") };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

describe("v2: hooks antes da tool", () => {
	it("lição confirm_always força o cartão no v2 mesmo em autonomia total, sem executar", async () => {
		const { call, events, result } = await run({
			lessons: [lessonWith({ kind: "confirm_always", tool: CREATE })],
			script: [calls([CREATE, { cliente: "Acme", pagamento: "pix" }])],
		});
		expect(call).not.toHaveBeenCalled();
		expect(events.some((e) => e.type === "confirm")).toBe(true);
		expect(saveSkillPendingIntent).toHaveBeenCalledTimes(1);
		expect(result.stop).toEqual({ reason: "awaiting_confirmation", detail: "confirm" });
	});

	it("sem a regra a mesma chamada executa direto", async () => {
		const { call, events } = await run({ script: [calls([CREATE, { cliente: "Acme", pagamento: "pix" }]), say("pronto")] });
		expect(call).toHaveBeenCalledTimes(1);
		expect(events.some((e) => e.type === "confirm")).toBe(false);
	});

	it("plano pendente bloqueia escrita com erro honesto e deixa o run seguir", async () => {
		const { call, results } = await run({ planPending: true, script: [calls([CREATE, { cliente: "Acme" }]), say("aguardo a aprovação do plano")] });
		expect(call).not.toHaveBeenCalled();
		expect(results[0]?.ok).toBe(false);
		expect(results[0]?.summary).toContain("plano aguardando aprovação");
	});

	it("required_args barra, e a chamada seguinte correta passa", async () => {
		const { call, results } = await run({
			lessons: [lessonWith({ kind: "required_args", tool: CREATE, fields: ["pagamento"], note: "o ERP recusa sem pagamento" })],
			script: [calls([CREATE, { cliente: "Acme" }]), calls([CREATE, { cliente: "Acme", pagamento: "pix" }]), say("pronto")],
		});
		expect(results.map((r) => r.ok)).toEqual([false, true]);
		expect(results[0]?.summary).toContain("pagamento");
		expect(call).toHaveBeenCalledTimes(1);
	});
});

describe("v2: erro de controle na entrega final", () => {
	// Sem teto em US$ de fábrica: o teto vem do dono (conta), como em produção quando ele programa um.
	const ownerCap = { budget: { maxCostUsd: 1 } };
	const overBudget = () => calls([CREATE, { cliente: "A", pagamento: "pix" }], { promptTokens: 10, completionTokens: 1, costUsd: 5 });

	it("lease perdido na chamada de entrega propaga e o run não conclui", async () => {
		await expect(
			run({
				script: [
					overBudget,
					() => {
						throw new LeaseLostError();
					},
				],
				extra: ownerCap,
			}),
		).rejects.toBeInstanceOf(LeaseLostError);
	});

	it("shouldContinue falso (cancelado) na entrega propaga como cancelamento", async () => {
		let allowed = 2;
		await expect(
			run({
				script: [overBudget, say("entrega")],
				extra: { ...ownerCap, shouldContinue: async () => allowed-- > 0 },
			}),
		).rejects.toMatchObject({ name: expect.stringMatching(/Cancel/i) });
	});

	it("abort durante a entrega propaga", async () => {
		const controller = new AbortController();
		await expect(
			run({
				script: [
					overBudget,
					() => {
						controller.abort(new LeaseLostError());
						throw new Error("abortado");
					},
				],
				extra: { ...ownerCap, abortSignal: controller.signal },
			}),
		).rejects.toBeInstanceOf(LeaseLostError);
	});
});

describe("v2: tetos do custo, do tempo e dos passos", () => {
	it("custo desconhecido é estimado pelos tokens e o teto em US$ passa a valer", async () => {
		// Sem costUsd do provedor: 100k prompt + 10k saída ~ US$ 0,45 por chamada; teto do perfil US$ 0,5.
		const unknown = () => calls([CREATE, { cliente: "A", pagamento: "pix" }], { promptTokens: 100_000, completionTokens: 10_000 });
		const { result, requests } = await run({
			script: [unknown, unknown, say("Entrega com o que deu.")],
			options: { profile: "long_work", longWorkBudgetUsd: 0.5 },
		});
		expect(requests.map((r) => r.toolChoice)).toEqual(["auto", "auto", "none"]);
		expect(result.stop).toEqual({ reason: "budget_cost", detail: "delivered" });
	});

	it("o teto de tempo do run (budget.maxWallMs) vale mais que o do perfil", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-11-01T12:00:00Z"));
		const slow = () => {
			vi.setSystemTime(Date.now() + 61_000);
			return calls([CREATE, { cliente: "A", pagamento: "pix" }]);
		};
		const { result, requests } = await run({
			script: [slow, say("Entrega.")],
			options: { profile: "long_work" },
			extra: { budget: { maxWallMs: 60_000 } },
		});
		expect(requests.map((r) => r.toolChoice)).toEqual(["auto", "none"]);
		expect(result.stop).toEqual({ reason: "budget_wall", detail: "delivered" });
	});

	it("o teto de passos do run (maxSteps) vale mais que o de segurança do motor", async () => {
		const more = () => calls([CREATE, { cliente: "A", pagamento: `p${seq}` }]);
		const { result, requests } = await run({ script: [more, more, say("Entrega.")], extra: { maxSteps: 2 } });
		expect(requests.map((r) => r.toolChoice)).toEqual(["auto", "auto", "none"]);
		expect(result.stop).toEqual({ reason: "budget_steps", detail: "delivered" });
	});
});

describe("v2: login repetido no mesmo site", () => {
	const event = { type: "login" as const, loginId: "l1", site: "erp.example.com", url: "https://erp.example.com/login", runId: "r", status: "pending" as const };
	const summary = "Página de login.\nLOGIN REQUIRED on erp.example.com: peça ao usuário.";

	it("o primeiro pedido abre o card; o segundo ao mesmo site vira nota sem card", () => {
		const asked = new Set<string>();
		const first = dedupeLoginAsk({ event, summary, asked });
		expect(first.event).toBe(event);
		expect(first.summary).toBe(summary);
		const second = dedupeLoginAsk({ event: { ...event, loginId: "l2" }, summary, asked });
		expect(second.event).toBeUndefined();
		expect(second.summary).toContain("LOGIN STILL REQUIRED on erp.example.com");
		expect(second.summary).not.toContain("LOGIN REQUIRED on");
	});

	it("site que o histórico recente já pediu (30 min) não abre card de novo; captcha sempre pede", () => {
		expect(dedupeLoginAsk({ event, summary, asked: new Set(["erp.example.com"]) }).event).toBeUndefined();
		const captcha = { ...event, reason: "captcha" as const };
		expect(dedupeLoginAsk({ event: captcha, summary, asked: new Set(["erp.example.com"]) }).event).toBe(captcha);
	});
});
