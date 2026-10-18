import { describe, expect, it } from "vitest";
import {
	budgetLeftFraction,
	mostConstrainedBudgetRatio,
	planToolCallExtension,
	pushToolCallRecord,
	TOOL_CALL_HISTORY_SIZE,
	type ToolCallRecord,
} from "./tool-budget.js";

const distinctOk = (n: number): ToolCallRecord[] =>
	Array.from({ length: n }, (_, i) => ({ argsHash: `h${i}`, ok: true }));

const base = {
	readOnly: true,
	used: 40,
	cap: 40,
	recentCalls: distinctOk(10),
	hardCap: 200,
	budgetLeftRatio: 0.8,
};

describe("planToolCallExtension", () => {
	it("estende +50% quando as chamadas são distintas e ok", () => {
		expect(planToolCallExtension(base)).toEqual({
			extend: true,
			newCap: 60,
			reason: "progressing",
		});
	});

	it("estende no mínimo +10 para tetos pequenos", () => {
		const plan = planToolCallExtension({ ...base, used: 8, cap: 8 });
		expect(plan.newCap).toBe(18);
	});

	it("não estende repetindo os mesmos args", () => {
		const recentCalls = distinctOk(10).map((c, i) => ({
			...c,
			argsHash: i < 3 ? `h${i}` : "same",
		}));
		const plan = planToolCallExtension({ ...base, recentCalls });
		expect(plan).toMatchObject({ extend: false, newCap: 40, reason: "repeating" });
	});

	it("tolera 1 repetição em 10 (90% distintas)", () => {
		const recentCalls = distinctOk(10);
		recentCalls[9] = { argsHash: "h0", ok: true };
		expect(planToolCallExtension({ ...base, recentCalls }).extend).toBe(true);
	});

	it("não estende com muitas falhas", () => {
		const recentCalls = distinctOk(10).map((c, i) => ({ ...c, ok: i >= 4 }));
		expect(planToolCallExtension({ ...base, recentCalls })).toMatchObject({
			extend: false,
			reason: "failing",
		});
	});

	it("não estende com pouco orçamento restante", () => {
		expect(
			planToolCallExtension({ ...base, budgetLeftRatio: 0.2 }),
		).toMatchObject({ extend: false, reason: "low_budget" });
	});

	it("trunca no hardCap e não passa dele", () => {
		expect(planToolCallExtension({ ...base, used: 190, cap: 190 }).newCap).toBe(200);
		expect(
			planToolCallExtension({ ...base, used: 200, cap: 200 }),
		).toMatchObject({ extend: false, reason: "at_limit" });
	});

	it("não estende escrita", () => {
		expect(
			planToolCallExtension({ ...base, readOnly: false, used: 10, cap: 10 }),
		).toMatchObject({ extend: false, reason: "write_tool" });
	});

	it("respeita teto fixo do bot", () => {
		expect(
			planToolCallExtension({ ...base, fixedCeiling: 40 }),
		).toMatchObject({ extend: false, reason: "at_limit" });
		expect(
			planToolCallExtension({ ...base, fixedCeiling: 50 }),
		).toMatchObject({ extend: true, newCap: 50 });
	});

	it("sem histórico não estende", () => {
		expect(
			planToolCallExtension({ ...base, recentCalls: [] }),
		).toMatchObject({ extend: false, reason: "no_history" });
	});
});

describe("helpers de orçamento", () => {
	it("pega a menor fração restante", () => {
		expect(
			mostConstrainedBudgetRatio([
				budgetLeftFraction(100, 10),
				budgetLeftFraction(1000, 900),
				undefined,
			]),
		).toBeCloseTo(0.1);
		expect(mostConstrainedBudgetRatio([undefined])).toBe(1);
		expect(budgetLeftFraction(0, 5)).toBeUndefined();
	});

	it("histórico guarda só as últimas chamadas", () => {
		let history: ToolCallRecord[] | undefined;
		for (let i = 0; i < 15; i += 1) {
			history = pushToolCallRecord(history, { argsHash: `h${i}`, ok: true });
		}
		expect(history).toHaveLength(TOOL_CALL_HISTORY_SIZE);
		expect(history?.[0]?.argsHash).toBe("h5");
	});
});
