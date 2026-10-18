import { describe, expect, it } from "vitest";
import {
	formatIntervalSummary,
	isIntervalTrigger,
	parseIntervalEveryMinutes,
	parseRoutineTriggerJson,
} from "./index.js";

describe("parseIntervalEveryMinutes", () => {
	it("rejeita abaixo do mínimo (4)", () => {
		const result = parseIntervalEveryMinutes({ everyMinutes: 4 });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/5 minutos/);
	});

	it("rejeita acima do máximo (1441)", () => {
		const result = parseIntervalEveryMinutes({ everyMinutes: 1441 });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/24 horas|1440/);
	});

	it("aceita o mínimo (5)", () => {
		expect(parseIntervalEveryMinutes({ everyMinutes: 5 })).toEqual({
			ok: true,
			everyMinutes: 5,
		});
	});

	it("aceita valor típico (50)", () => {
		expect(parseIntervalEveryMinutes({ everyMinutes: 50 })).toEqual({
			ok: true,
			everyMinutes: 50,
		});
	});

	it("aceita string numérica", () => {
		expect(parseIntervalEveryMinutes({ everyMinutes: "50" })).toEqual({
			ok: true,
			everyMinutes: 50,
		});
	});

	it("rejeita não-inteiro e vazio em pt-BR", () => {
		expect(parseIntervalEveryMinutes({ everyMinutes: 2.5 }).ok).toBe(false);
		expect(parseIntervalEveryMinutes({ everyMinutes: "" }).ok).toBe(false);
		expect(parseIntervalEveryMinutes({ everyMinutes: undefined }).ok).toBe(false);
	});
});

describe("formatIntervalSummary", () => {
	it('formata minutos ("A cada 50 min")', () => {
		expect(formatIntervalSummary(50)).toBe("A cada 50 min");
	});

	it('formata horas exatas ("A cada 2 h")', () => {
		expect(formatIntervalSummary(120)).toBe("A cada 2 h");
		expect(formatIntervalSummary(60)).toBe("A cada 1 h");
	});
});

describe("isIntervalTrigger / parseRoutineTriggerJson", () => {
	it("reconhece trigger interval válido", () => {
		expect(isIntervalTrigger({ kind: "interval", everyMinutes: 50 })).toBe(true);
		expect(isIntervalTrigger({ kind: "interval", everyMinutes: 4 })).toBe(false);
	});

	it("parseRoutineTriggerJson preserva interval", () => {
		expect(
			parseRoutineTriggerJson({ kind: "interval", everyMinutes: 50 }),
		).toEqual({ kind: "interval", everyMinutes: 50 });
	});
});
