import { describe, expect, it } from "vitest";
import {
	inferStopReasonFromLegacy,
	isRunStopReason,
	RUN_STOP_REASONS,
	sanitizeStopDetail,
	stopOfCompletion,
	stopReasonOfBudget,
	stopReasonOfLoop,
} from "./run-stop-reason.js";

describe("stopReasonOfBudget", () => {
	it("mapeia cada BudgetStopKind", () => {
		expect(stopReasonOfBudget("steps")).toBe("budget_steps");
		expect(stopReasonOfBudget("stalled")).toBe("budget_stalled");
		expect(stopReasonOfBudget("wall")).toBe("budget_wall");
		expect(stopReasonOfBudget("cost")).toBe("budget_cost");
		expect(stopReasonOfBudget("tokens")).toBe("budget_tokens");
		expect(stopReasonOfBudget("context")).toBe("budget_context");
		expect(stopReasonOfBudget("other")).toBe("other");
		expect(stopReasonOfBudget(undefined)).toBe("other");
	});
});

describe("stopReasonOfLoop", () => {
	it("mapeia cada trava de loop", () => {
		expect(stopReasonOfLoop("repeat")).toBe("loop_repeat");
		expect(stopReasonOfLoop("stall_guard")).toBe("loop_stall_guard");
		expect(stopReasonOfLoop("tool_failures")).toBe("tool_failures");
		expect(stopReasonOfLoop("truncated")).toBe("truncated");
		expect(stopReasonOfLoop("no_progress")).toBe("no_progress");
	});
	it("sem classificação cai em loop_repeat", () => {
		expect(stopReasonOfLoop(undefined)).toBe("loop_repeat");
	});
});

describe("stopOfCompletion", () => {
	it("resposta normal", () => {
		expect(stopOfCompletion(undefined)).toEqual({ reason: "answered" });
		expect(stopOfCompletion({})).toEqual({ reason: "answered" });
	});
	it("fechamento forçado pela estagnação", () => {
		expect(stopOfCompletion({ forcedWrap: true, forcedWrapCause: "stagnation" })).toEqual({
			reason: "answered_after_forced_wrap",
			detail: "stagnation",
		});
		expect(stopOfCompletion({ forcedWrap: true })).toEqual({ reason: "answered_after_forced_wrap" });
	});
	it("softEvaluate concluiu", () => {
		expect(stopOfCompletion({ softConcluded: true })).toEqual({ reason: "soft_concluded" });
	});
	it("parou em cartão, com o tipo no detalhe", () => {
		expect(stopOfCompletion({ awaiting: "confirm" })).toEqual({ reason: "awaiting_confirmation", detail: "confirm" });
		expect(stopOfCompletion({ awaiting: "questionnaire", forcedWrap: true })).toEqual({
			reason: "awaiting_confirmation",
			detail: "questionnaire",
		});
	});
	it("hitWall vira teto de passos", () => {
		expect(stopOfCompletion({}, { hitWall: true })).toEqual({ reason: "budget_steps" });
	});
});

describe("sanitizeStopDetail", () => {
	it("mantém rótulo curto e descarta o resto", () => {
		expect(sanitizeStopDetail("Stall Guard")).toBe("stall_guard");
		expect(sanitizeStopDetail("sk-abc123 Bearer xyz!")).toBe("sk-abc123_bearer_xyz");
		expect(sanitizeStopDetail("x".repeat(200))?.length).toBe(80);
		expect(sanitizeStopDetail("   ")).toBeUndefined();
		expect(sanitizeStopDetail(null)).toBeUndefined();
	});
});

describe("inferStopReasonFromLegacy", () => {
	it("usa o status quando basta", () => {
		expect(inferStopReasonFromLegacy({ status: "completed" })).toBe("answered");
		expect(inferStopReasonFromLegacy({ status: "cancelled", error: "cancelled" })).toBe("cancelled");
		expect(inferStopReasonFromLegacy({ status: "waiting_user" })).toBe("awaiting_confirmation");
	});
	it("lê o texto de error", () => {
		expect(inferStopReasonFromLegacy({ status: "failed", error: "O worker parou de responder no meio da execução (sem heartbeat). Tente de novo." })).toBe("crash_recoveries");
		expect(inferStopReasonFromLegacy({ status: "failed", error: "Falha após 3 tentativas: timeout" })).toBe("retries_exhausted");
		expect(inferStopReasonFromLegacy({ status: "budget_exhausted", error: "Limite de custo atingido" })).toBe("budget_cost");
		expect(inferStopReasonFromLegacy({ status: "budget_exhausted", error: "Limite de 40 passos" })).toBe("budget_steps");
		expect(inferStopReasonFromLegacy({ status: "failed", error: "Repeti a mesma ação" })).toBe("loop_repeat");
		expect(inferStopReasonFromLegacy({ status: "failed", error: "boom" })).toBe("error");
	});
});

describe("RUN_STOP_REASONS", () => {
	it("não tem repetidos e isRunStopReason valida", () => {
		expect(new Set(RUN_STOP_REASONS).size).toBe(RUN_STOP_REASONS.length);
		expect(isRunStopReason("budget_wall")).toBe(true);
		expect(isRunStopReason("nope")).toBe(false);
		expect(isRunStopReason(null)).toBe(false);
	});
});

describe("run-stop-reason em tempo linear (CodeQL)", () => {
	it("sanitizeStopDetail e inferStopReasonFromLegacy respondem rápido com entrada hostil", () => {
		const started = performance.now();
		sanitizeStopDetail(`${"_".repeat(50_000)}x`);
		inferStopReasonFromLegacy({ status: "failed", error: `recupera ${"recupera ".repeat(20_000)}` });
		inferStopReasonFromLegacy({ status: "failed", error: `falhou ${"falhas ".repeat(20_000)}` });
		inferStopReasonFromLegacy({ status: "failed", error: "ferramenta".repeat(20_000) });
		expect(performance.now() - started).toBeLessThan(200);
		expect(sanitizeStopDetail("__Waiting User__")).toBe("waiting_user");
		expect(inferStopReasonFromLegacy({ status: "failed", error: "Worker recuperou 3 vezes" })).toBe("crash_recoveries");
		expect(inferStopReasonFromLegacy({ status: "failed", error: "falhou 6 ferramentas seguidas" })).toBe("tool_failures");
	});
});
