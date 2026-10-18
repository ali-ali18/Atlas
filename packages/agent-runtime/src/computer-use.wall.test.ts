import { describe, expect, it, vi } from "vitest";
import type { AgentRunCheckpoint } from "@workspace/shared";
import type { SandboxManager } from "@workspace/sandbox";
import { runComputerUse } from "./computer-use.js";
import { classifyRunError } from "./errors.js";
import { wallClockAnchors } from "./budget.js";

vi.mock("@workspace/db", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@workspace/db")>();
	return {
		...actual,
		searchMemoryEntries: async () => [],
		getBotProfile: vi.fn(async () => null),
		listBotSkills: vi.fn(async () => []),
		searchSkillVersions: vi.fn(async () => []),
		listRoutines: vi.fn(async () => []),
	};
});

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;
const answer = { model: "test-model", message: { role: "assistant" as const, content: "pronto" } };

function base(restoredCheckpoint: AgentRunCheckpoint | null, extra: Partial<Parameters<typeof runComputerUse>[0]> = {}) {
	return {
		manager: {} as SandboxManager,
		getSessionId: async () => "session-1",
		sandboxEnabled: false,
		model: "test-model",
		apiKey: "test",
		messages: [{ role: "user" as const, content: "vai" }],
		runId: "run-wall",
		maxSteps: 5,
		restoredCheckpoint,
		onEvent: () => undefined,
		...extra,
	};
}

describe("teto de relógio conta só tempo ativo", () => {
	it("run iniciado há 4h com 2 min ativos retoma e conclui (pausa não conta)", async () => {
		const streamChat = vi.fn(async () => answer);
		let saved: AgentRunCheckpoint | undefined;
		const result = await runComputerUse(
			base(
				{ version: 1, messages: [], nextStepIndex: 0, activeElapsedMs: 2 * MIN },
				{
					runStartedAt: Date.now() - 4 * HOUR,
					streamChat,
					onCheckpoint: async (value) => { saved = value; },
				},
			),
		);
		expect(result.text).toContain("pronto");
		expect(streamChat).toHaveBeenCalled();
		// O checkpoint acumula o tempo ativo (>= o que já tinha, e longe das 4h).
		expect(saved?.activeElapsedMs).toBeGreaterThanOrEqual(2 * MIN);
		expect(saved?.activeElapsedMs).toBeLessThan(3 * MIN);
	});

	it("orçamento ativo já esgotado na retomada vira BudgetExhaustedError, não timeout", async () => {
		const streamChat = vi.fn(async () => answer);
		const error = await runComputerUse(
			base(
				{ version: 1, messages: [], nextStepIndex: 0, activeElapsedMs: 31 * MIN },
				{ runStartedAt: Date.now() - 4 * HOUR, streamChat },
			),
		).catch((e: unknown) => e);
		expect(error).toMatchObject({ name: "BudgetExhaustedError" });
		expect(classifyRunError(error)).toBe("budget_exhausted");
		expect((error as Error).message).toMatch(/tempo máximo do run esgotado \(30 min\)/);
		// Só a chamada final de resumo, sem tools (nenhum passo de trabalho).
		expect(streamChat).toHaveBeenCalledTimes(1);
		expect(streamChat.mock.calls[0]?.[0]).toMatchObject({ toolChoice: "none" });
	});

	it("prazo estourando no meio da execução também é budget_exhausted", async () => {
		const error = await runComputerUse(
			base(
				{ version: 1, messages: [], nextStepIndex: 0, activeElapsedMs: 0 },
				{
					budget: { maxWallMs: 30 },
					streamChat: (async (opts: { signal?: AbortSignal }) => {
						await new Promise((resolve) => setTimeout(resolve, 200));
						opts.signal?.throwIfAborted();
						return answer;
					}) as never,
					abortSignal: undefined,
				},
			),
		).catch((e: unknown) => e);
		expect(classifyRunError(error)).toBe("budget_exhausted");
	});
});

describe("wallClockAnchors", () => {
	it("sem checkpoint ancora no início do run", () => {
		const r = wallClockAnchors({ maxWallMs: 30 * MIN, now: 1_000_000, runStartedAt: 400_000, restored: null });
		expect(r).toEqual({ baseMs: 0, executionStartMs: 400_000, deadlineAtMs: 400_000 + 30 * MIN });
	});
	it("com checkpoint ancora em agora e desconta o tempo ativo", () => {
		const r = wallClockAnchors({ maxWallMs: 30 * MIN, now: 1_000_000, runStartedAt: 1, restored: { activeElapsedMs: 2 * MIN } });
		expect(r).toEqual({ baseMs: 2 * MIN, executionStartMs: 1_000_000, deadlineAtMs: 1_000_000 + 28 * MIN });
	});
	it("checkpoint antigo sem activeElapsedMs conta 0; esgotado dá prazo = agora", () => {
		expect(wallClockAnchors({ maxWallMs: 30 * MIN, now: 5, restored: {} }).deadlineAtMs).toBe(5 + 30 * MIN);
		expect(wallClockAnchors({ maxWallMs: 30 * MIN, now: 5, restored: { activeElapsedMs: 40 * MIN } }).deadlineAtMs).toBe(5);
	});
});
