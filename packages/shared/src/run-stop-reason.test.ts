import { describe, expect, it } from "vitest";
import {
	describeRunStop,
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

describe("stoppedWithOpenWork", () => {
	it("só há trabalho por fazer quando sobraram itens abertos da lista DO run, qualquer que seja o motivo da parada", async () => {
		const { stoppedWithOpenWork } = await import("./run-stop-reason.js");
		for (const stop of [
			{ reason: "answered", detail: "tasklist_open" },
			{ reason: "loop_repeat", detail: "after_note:items_open" },
			{ reason: "budget_steps", detail: "delivered:items_open" },
			{ reason: "budget_wall", detail: "items_open" },
			{ reason: "answered", detail: "items_open" },
		]) expect(stoppedWithOpenWork(stop), JSON.stringify(stop)).toBe(true);
		// Parar por laço, teto ou falhas SEM itens abertos deste run não herda nada: a mensagem seguinte é assunto novo.
		for (const stop of [{ reason: "loop_repeat" }, { reason: "budget_steps" }, { reason: "tool_failures" }, { reason: "budget_cost", detail: "delivered" }, { reason: "answered" }, { reason: "cancelled" }, { reason: null }, {}]) expect(stoppedWithOpenWork(stop), JSON.stringify(stop)).toBe(false);
	});
});

describe("awaiting_owner (run v4 estacionado esperando o dono)", () => {
	it("é motivo válido e se descreve sem falar em login", () => {
		expect(isRunStopReason("awaiting_owner")).toBe(true);
		expect(describeRunStop({ reason: "awaiting_owner" })).toBe("Esperando a sua decisão");
		expect(describeRunStop({ reason: "awaiting_owner" })).not.toMatch(/login/i);
	});
});

describe("describeRunStop (Motivo da parada, em pt-BR simples)", () => {
	it("teto de gasto configurado cita valor e origem; teto de tempo também", () => {
		expect(describeRunStop({ reason: "budget_cost", detail: "delivered" }, { costUsd: 0.25, costSource: "server" })).toBe("Teto de gasto configurado (US$ 0,25 · servidor)");
		expect(describeRunStop({ reason: "budget_cost" }, { costUsd: 2, costSource: "bot" })).toBe("Teto de gasto configurado (US$ 2,00 · bot)");
		expect(describeRunStop({ reason: "budget_cost" }, { costUsd: 1, costSource: "account" })).toBe("Teto de gasto configurado (US$ 1,00 · conta)");
		expect(describeRunStop({ reason: "budget_wall" }, { wallMs: 20 * 60_000, wallSource: "bot" })).toBe("Teto de tempo configurado (20 min · bot)");
		// Run antigo, sem teto gravado: não inventa valor nem origem.
		expect(describeRunStop({ reason: "budget_cost" })).toBe("Teto de gasto configurado");
	});

	it("repetição e falhas dizem que a abordagem não funcionou, sem falar em teto; itens abertos aparecem", () => {
		for (const reason of ["loop_repeat", "tool_failures"]) {
			const text = describeRunStop({ reason, detail: "after_note:items_open" })!;
			expect(text).toMatch(/abordagem não funcionou/);
			expect(text).toMatch(/itens em aberto/);
			expect(text).not.toMatch(/teto|limite|orçamento|tempo/i);
		}
	});

	it("limite de passos é de segurança; resposta normal e motivo desconhecido não mostram nada", () => {
		expect(describeRunStop({ reason: "budget_steps" })).toBe("Limite de passos de segurança de uma execução");
		// Teto do dono (conta, bot ou pedido): diz valor e origem. O de segurança mostra o valor real e não vira "que você configurou".
		expect(describeRunStop({ reason: "budget_steps" }, { steps: 80, stepsSource: "bot" })).toBe("Limite de passos que você configurou (80, em bot)");
		expect(describeRunStop({ reason: "budget_steps" }, { steps: 120, stepsSource: "account" })).toBe("Limite de passos que você configurou (120, em conta)");
		expect(describeRunStop({ reason: "budget_steps" }, { steps: 50, stepsSource: "request" })).toBe("Limite de passos que você configurou (50, em pedido)");
		expect(describeRunStop({ reason: "budget_steps" }, { steps: 200 })).toBe("Limite de passos de segurança de uma execução (200)");
		expect(describeRunStop({ reason: "answered" })).toBeUndefined();
		expect(describeRunStop({ reason: "algo_novo" })).toBeUndefined();
		expect(describeRunStop({})).toBeUndefined();
	});
});
