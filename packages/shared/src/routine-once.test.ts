import { describe, expect, it } from "vitest";
import {
	formatOnceSummary,
	parseOnceRunAt,
	planOnceRoutine,
	shouldAutoDeleteAfterRun,
} from "./routine-once.js";

const NOW = new Date("2026-09-28T12:00:00.000Z");

describe("parseOnceRunAt", () => {
	it("rejeita data no passado", () => {
		const result = parseOnceRunAt({ runAt: "2026-09-01T10:00:00Z" }, NOW);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/futuro/);
	});

	it("rejeita mais de 1 ano à frente", () => {
		const result = parseOnceRunAt({ runAt: "2028-01-01T10:00:00Z" }, NOW);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/1 ano/);
	});

	it("interpreta horário sem fuso como America/Sao_Paulo por padrão", () => {
		const result = parseOnceRunAt({ runAt: "2026-10-03T10:00" }, NOW);
		expect(result.ok).toBe(true);
		// 10:00 em -03:00 => 13:00 UTC.
		if (result.ok) expect(result.runAtIso).toBe("2026-10-03T13:00:00.000Z");
	});

	it("respeita timezone explícito quando informado", () => {
		const result = parseOnceRunAt(
			{ runAt: "2026-10-03T10:00", timezone: "UTC" },
			NOW,
		);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.runAtIso).toBe("2026-10-03T10:00:00.000Z");
	});

	it("aceita ISO com offset explícito, ignorando o timezone default", () => {
		const result = parseOnceRunAt({ runAt: "2026-10-03T10:00:00-03:00" }, NOW);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.runAtIso).toBe("2026-10-03T13:00:00.000Z");
	});

	it("aceita ISO em Z", () => {
		const result = parseOnceRunAt({ runAt: "2026-10-03T13:00:00Z" }, NOW);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.runAtIso).toBe("2026-10-03T13:00:00.000Z");
	});

	it("rejeita string vazia ou não reconhecida", () => {
		expect(parseOnceRunAt({ runAt: "" }, NOW).ok).toBe(false);
		expect(parseOnceRunAt({ runAt: "amanhã de manhã" }, NOW).ok).toBe(false);
	});

	it("tolera pequena folga no passado (clock skew)", () => {
		const result = parseOnceRunAt(
			{ runAt: new Date(NOW.getTime() - 30_000).toISOString() },
			NOW,
		);
		expect(result.ok).toBe(true);
	});
});

describe("formatOnceSummary", () => {
	it('formata "Uma vez · dd/MM às HH:mm" em America/Sao_Paulo', () => {
		expect(formatOnceSummary("2026-10-03T13:00:00.000Z")).toBe("Uma vez · 03/10 às 10:00");
	});

	it("aceita outro fuso explícito", () => {
		expect(formatOnceSummary("2026-10-03T13:00:00.000Z", "UTC")).toBe("Uma vez · 03/10 às 13:00");
	});
});

describe("planOnceRoutine", () => {
	it("agenda quando o horário ainda não chegou", () => {
		const runAt = new Date(NOW.getTime() + 5 * 60_000).toISOString();
		const plan = planOnceRoutine(runAt, NOW);
		expect(plan.action).toBe("schedule");
		if (plan.action === "schedule") expect(plan.delayMs).toBe(5 * 60_000);
	});

	it("roda agora quando passou até 1h", () => {
		const runAt = new Date(NOW.getTime() - 30 * 60_000).toISOString();
		expect(planOnceRoutine(runAt, NOW)).toEqual({ action: "run-now" });
	});

	it("roda agora exatamente na borda de 1h de atraso", () => {
		const runAt = new Date(NOW.getTime() - 60 * 60_000).toISOString();
		expect(planOnceRoutine(runAt, NOW)).toEqual({ action: "run-now" });
	});

	it("marca perdida quando passou de 1h", () => {
		const runAt = new Date(NOW.getTime() - 61 * 60_000).toISOString();
		expect(planOnceRoutine(runAt, NOW)).toEqual({ action: "missed" });
	});

	it("marca perdida quando runAt é inválido", () => {
		expect(planOnceRoutine("not-a-date", NOW)).toEqual({ action: "missed" });
	});
});

describe("shouldAutoDeleteAfterRun", () => {
	it("só once se auto-apaga", () => {
		expect(shouldAutoDeleteAfterRun("once")).toBe(true);
		expect(shouldAutoDeleteAfterRun("cron")).toBe(false);
		expect(shouldAutoDeleteAfterRun("event")).toBe(false);
	});
});
