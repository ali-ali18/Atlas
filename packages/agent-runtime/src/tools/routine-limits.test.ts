import { describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsParams, CompleteChatWithToolsResult } from "@workspace/llm";
import type { SandboxManager } from "@workspace/sandbox";
import type { RoutineLimits, RoutineRecord } from "@workspace/shared";
import type { ComputerUseParams } from "../run-types.js";
import { COMPUTER_USE_TOOLS } from "./catalog.js";
import { getToolMeta } from "./registry/tool-meta.js";
import type { ToolContext } from "./registry/types.js";
import { ROUTINE_LIMITS_TOOL_NAME, executeRoutineLimits, type RoutineLimitsStore } from "./routine-limits.js";
import { runEngineV3 } from "../engine-v3/loop.js";

vi.mock("@workspace/db", async (original) => ({
	...(await original<typeof import("@workspace/db")>()),
	getBotProfile: vi.fn(async () => ({ description: "configurado" })),
	getConversationUntrustedAt: vi.fn(async () => null),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
}));

/** Banco em memória: uma rotina do usuário A no bot A; o escopo (dono + bot) é o mesmo do `updateRoutine` real. */
function fakeStore() {
	const routine = { id: "r1", name: "Resumo do dia", userId: "user-a", botId: "bot-a", triggerType: "cron", limits: undefined as RoutineLimits | undefined };
	const store: RoutineLimitsStore = {
		resolve: async (scope, target) => (scope.userId === routine.userId && scope.botId === routine.botId && (target === routine.id || target === routine.name) ? { kind: "one", routine: routine as unknown as RoutineRecord } : { kind: "none" }),
		update: async (scope, routineId, patch) => {
			if (scope.userId !== routine.userId || routineId !== routine.id) return null;
			if (patch === null) routine.limits = undefined;
			else {
				const next: RoutineLimits = { ...(routine.limits ?? {}) };
				for (const key of ["maxSteps", "maxCostUsd"] as const) {
					if (patch[key] === null) delete next[key];
					else if (patch[key] !== undefined) next[key] = patch[key]!;
				}
				routine.limits = Object.keys(next).length > 0 ? next : undefined;
			}
			return routine as unknown as RoutineRecord;
		},
	};
	return { routine, store };
}

const ctx = (userId = "user-a"): ToolContext => ({ userId, botId: "bot-a", conversationId: "conv-1", runId: "run1", origin: "chat" }) as unknown as ToolContext;

describe("routine_limits: o dono muda os limites da rotina pelo chat", () => {
	it("sobe os passos e põe teto em US$; o cartão mostra o resumo em frase", async () => {
		const { routine, store } = fakeStore();
		const result = await executeRoutineLimits({ target: "Resumo do dia", maxSteps: 80, maxCostUsd: 0.5 }, ctx(), store);
		expect(routine.limits).toEqual({ maxSteps: 80, maxCostUsd: 0.5 });
		expect(result.routineEvent).toMatchObject({ type: "routine", action: "updated", routineId: "r1", detail: "Até 80 passos · até US$ 0,50 por execução" });
	});

	it("reset volta ao padrão (40 passos, sem teto em US$)", async () => {
		const { routine, store } = fakeStore();
		routine.limits = { maxSteps: 80, maxCostUsd: 1 };
		await executeRoutineLimits({ target: "r1", reset: ["maxSteps", "maxCostUsd"] }, ctx(), store);
		expect(routine.limits).toBeUndefined();
	});

	it("fora da faixa, vazio ou contraditório falha com o motivo e não grava", async () => {
		const { routine, store } = fakeStore();
		await expect(executeRoutineLimits({ target: "r1", maxSteps: 500 }, ctx(), store)).rejects.toThrow(/de 5 a 200/);
		await expect(executeRoutineLimits({ target: "r1", maxCostUsd: 0 }, ctx(), store)).rejects.toThrow(/maxCostUsd/);
		await expect(executeRoutineLimits({ target: "r1" }, ctx(), store)).rejects.toThrow(/Accepted fields: maxSteps, maxCostUsd, reset/);
		await expect(executeRoutineLimits({ target: "r1", maxSteps: 50, reset: ["maxSteps"] }, ctx(), store)).rejects.toThrow(/both set and reset/);
		expect(routine.limits).toBeUndefined();
	});

	it("rotina de outro usuário: não acha e não grava", async () => {
		const { routine, store } = fakeStore();
		await expect(executeRoutineLimits({ target: "r1", maxSteps: 80 }, ctx("user-b"), store)).rejects.toThrow(/No routine/);
		expect(routine.limits).toBeUndefined();
	});

	it("metadado: escrita interna que precisa de humano (a rotina não sobe o próprio teto)", () => {
		expect(getToolMeta(ROUTINE_LIMITS_TOOL_NAME)).toMatchObject({ effect: "write_internal", needsHuman: true });
	});
});

describe("routine_limits no catálogo", () => {
	const say = (content: string): CompleteChatWithToolsResult => ({ model: "m", message: { role: "assistant", content }, finishReason: "stop" });
	async function offered(extra: Partial<ComputerUseParams>): Promise<string> {
		const requests: CompleteChatWithToolsParams[] = [];
		await runEngineV3({
			manager: {} as SandboxManager,
			getSessionId: async () => "s",
			sandboxEnabled: false,
			model: "m",
			apiKey: "k",
			runId: "run1",
			userId: "user-a",
			botId: "bot-a",
			conversationId: "conv-1",
			origin: "chat",
			humanTurn: true,
			messages: [{ role: "user", content: "sobe o limite da rotina para 80 passos" }],
			onEvent: () => undefined,
			streamChat: async (params) => {
				requests.push(params);
				return say("ok");
			},
			...extra,
		}).catch(() => undefined);
		const first = requests[0]!;
		return [...(first.tools ?? []).map((tool) => tool.function.name), ...first.messages.map((message) => (typeof message.content === "string" ? message.content : ""))].join(" ");
	}

	it("v1/v2 não oferecem; o v3 oferece no chat com pessoa e esconde na rotina", async () => {
		expect(COMPUTER_USE_TOOLS.map((tool) => tool.function.name)).not.toContain(ROUTINE_LIMITS_TOOL_NAME);
		expect(await offered({})).toContain(ROUTINE_LIMITS_TOOL_NAME);
		expect(await offered({ origin: "routine", humanTurn: false })).not.toContain(ROUTINE_LIMITS_TOOL_NAME);
	});
});
