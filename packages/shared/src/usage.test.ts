import { describe, expect, it } from "vitest";
import {
	REMOVED_BOT_LABEL,
	USAGE_OTHERS_KEY,
	composeUsage,
	isUsagePeriod,
	isValidTimeZone,
	usagePeriodRange,
	type UsageGroupRow,
} from "./usage.js";

const SP = "America/Sao_Paulo";

describe("usagePeriodRange", () => {
	it("hoje: meia-noite local até a meia-noite seguinte (fuso -03)", () => {
		// 01:30Z = 22:30 de 04/10 em São Paulo
		const { from, to } = usagePeriodRange("today", new Date("2026-10-05T01:30:00Z"), SP);
		expect(from.toISOString()).toBe("2026-10-04T03:00:00.000Z");
		expect(to.toISOString()).toBe("2026-10-05T03:00:00.000Z");
	});

	it("virada de dia: 00:00 local já é o dia novo; 23:59 local ainda é o antigo", () => {
		expect(usagePeriodRange("today", new Date("2026-10-05T03:00:00Z"), SP).from.toISOString()).toBe("2026-10-05T03:00:00.000Z");
		expect(usagePeriodRange("today", new Date("2026-10-05T02:59:59Z"), SP).from.toISOString()).toBe("2026-10-04T03:00:00.000Z");
	});

	it("7d e 30d incluem hoje e voltam 6 e 29 dias", () => {
		const now = new Date("2026-10-15T15:00:00Z");
		expect(usagePeriodRange("7d", now, "UTC").from.toISOString()).toBe("2026-10-09T00:00:00.000Z");
		expect(usagePeriodRange("30d", now, "UTC").from.toISOString()).toBe("2026-09-16T00:00:00.000Z");
		expect(usagePeriodRange("30d", now, "UTC").to.toISOString()).toBe("2026-10-16T00:00:00.000Z");
	});

	it("horário de verão: dias de 23 h e de 25 h usam a meia-noite local de cada dia", () => {
		const ny = "America/New_York";
		const spring = usagePeriodRange("today", new Date("2026-03-08T18:00:00Z"), ny);
		expect(spring.from.toISOString()).toBe("2026-03-08T05:00:00.000Z");
		expect(spring.to.toISOString()).toBe("2026-03-09T04:00:00.000Z");
		const fall = usagePeriodRange("today", new Date("2026-11-01T18:00:00Z"), ny);
		expect(fall.from.toISOString()).toBe("2026-11-01T04:00:00.000Z");
		expect(fall.to.toISOString()).toBe("2026-11-02T05:00:00.000Z");
		// 7d atravessando o DST começa na meia-noite local (offset antigo)
		const week = usagePeriodRange("7d", new Date("2026-03-10T18:00:00Z"), ny);
		expect(week.from.toISOString()).toBe("2026-03-04T05:00:00.000Z");
	});

	it("virada de mês e ano", () => {
		const { from } = usagePeriodRange("7d", new Date("2027-01-03T12:00:00Z"), "UTC");
		expect(from.toISOString()).toBe("2026-12-28T00:00:00.000Z");
	});
});

describe("validação", () => {
	it("período", () => {
		expect(isUsagePeriod("7d")).toBe(true);
		expect(isUsagePeriod("90d")).toBe(false);
		expect(isUsagePeriod(undefined)).toBe(false);
	});
	it("fuso IANA", () => {
		expect(isValidTimeZone(SP)).toBe(true);
		expect(isValidTimeZone("UTC")).toBe(true);
		expect(isValidTimeZone("Marte/Olympus")).toBe(false);
		expect(isValidTimeZone("")).toBe(false);
		expect(isValidTimeZone("a".repeat(65))).toBe(false);
		expect(isValidTimeZone("UTC; DROP TABLE")).toBe(false);
		expect(isValidTimeZone(42)).toBe(false);
	});
});

const row = (over: Partial<UsageGroupRow>): UsageGroupRow => ({
	botId: "b1",
	model: "m1",
	runs: 1,
	costUsd: 0.1,
	costUnknownCalls: 0,
	planCalls: 0,
	promptTokens: 10,
	completionTokens: 5,
	cachedTokens: 2,
	...over,
});

describe("composeUsage", () => {
	it("vazio = zeros, custo ausente (não 0)", () => {
		const out = composeUsage({ rows: [], botNames: new Map() });
		expect(out.totals.runs).toBe(0);
		expect(out.totals.costUsd).toBeNull();
		expect(out.byBot).toEqual([]);
		expect(out.byModel).toEqual([]);
	});

	it("soma por bot e por modelo; bot removido e sem bot ganham rótulo", () => {
		const out = composeUsage({
			rows: [
				row({ botId: "b1", model: "m1", costUsd: 0.5, runs: 2 }),
				row({ botId: "b1", model: "m2", costUsd: 0.25 }),
				row({ botId: "gone", model: "m1", costUsd: 0.1 }),
				row({ botId: null, model: "m1", costUsd: null, planCalls: 3 }),
			],
			botNames: new Map([["b1", "Ana"]]),
		});
		expect(out.totals.runs).toBe(5);
		expect(out.totals.costUsd).toBeCloseTo(0.85);
		expect(out.totals.planCalls).toBe(3);
		expect(out.byBot.map((b) => [b.name, b.costUsd])).toEqual([
			["Ana", 0.75],
			["Bot removido", 0.1],
			["Sem bot", null],
		]);
		expect(out.byBot[1]!.name).toBe(REMOVED_BOT_LABEL);
		expect(out.byModel.map((m) => m.model)).toEqual(["m1", "m2"]);
		expect(out.byModel[0]!.runs).toBe(4);
	});

	it("custo parcial propaga costUnknownCalls e soma só o conhecido", () => {
		const out = composeUsage({
			rows: [row({ costUsd: 0.2, costUnknownCalls: 2 }), row({ model: "m2", costUsd: null, costUnknownCalls: 1 })],
			botNames: new Map(),
		});
		expect(out.totals.costUsd).toBeCloseTo(0.2);
		expect(out.totals.costUnknownCalls).toBe(3);
	});

	it("top N + Outros preserva o total", () => {
		const rows = Array.from({ length: 5 }, (_, i) => row({ model: `m${i}`, costUsd: i + 1 }));
		const out = composeUsage({ rows, botNames: new Map(), topN: 2 });
		expect(out.byModel.map((m) => m.key)).toEqual(["m4", "m3", USAGE_OTHERS_KEY]);
		expect(out.byModel[2]!.costUsd).toBe(6);
		expect(out.byModel[2]!.runs).toBe(3);
		expect(out.totals.costUsd).toBe(15);
	});
});
