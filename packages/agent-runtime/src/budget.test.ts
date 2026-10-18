import { describe, expect, it } from "vitest";
import {
	addUsage,
	BUDGET_HARD_CAP,
	emptyUsage,
	parseBudgetPolicy,
	resolveBudget,
} from "./budget.js";

describe("resolveBudget", () => {
	it("padrão: soft 24, hard 100, extensão 24", () => {
		const budget = resolveBudget({});
		expect(budget.hardMaxSteps).toBe(BUDGET_HARD_CAP);
		expect(budget.softMaxSteps).toBe(24);
		expect(budget.extensionSteps).toBe(24);
		expect(budget.maxWallMs).toBeGreaterThan(0);
		expect(budget.maxTokens).toBeUndefined();
	});

	it("precedência request < policy e teto 100", () => {
		expect(resolveBudget({ maxSteps: 30 }).hardMaxSteps).toBe(30);
		expect(
			resolveBudget({ maxSteps: 30, policy: { hardMaxSteps: 50 } }).hardMaxSteps,
		).toBe(50);
		expect(resolveBudget({ maxSteps: 500 }).hardMaxSteps).toBe(BUDGET_HARD_CAP);
	});

	it("soft nunca passa do hard; hard pequeno pula a fase soft", () => {
		expect(resolveBudget({ maxSteps: 4 }).softMaxSteps).toBe(4);
		expect(resolveBudget({ maxSteps: 16 }).softMaxSteps).toBe(16);
	});
});

describe("parseBudgetPolicy", () => {
	it("ignora lixo sem explodir", () => {
		expect(parseBudgetPolicy(null)).toEqual({});
		expect(parseBudgetPolicy("x")).toEqual({});
		expect(parseBudgetPolicy([])).toEqual({});
		expect(
			parseBudgetPolicy({
				hardMaxSteps: -3,
				maxWallMs: Number.NaN,
				maxCallsPerTool: { navigate: 5, x: "y" },
			}),
		).toEqual({ maxCallsPerTool: { navigate: 5 } });
	});
});

describe("addUsage", () => {
	it("acumula com fallback prompt+completion", () => {
		const total = addUsage(emptyUsage(), { promptTokens: 10 });
		expect(addUsage(total, { totalTokens: 7 })).toEqual({
			promptTokens: 10,
			completionTokens: 0,
			totalTokens: 17,
		});
	});

	it("soma custo real e tokens em cache; sem custo informado, não inventa", () => {
		let total = addUsage(emptyUsage(), { promptTokens: 5 });
		expect(total.costUsd).toBeUndefined();
		total = addUsage(total, { promptTokens: 100, costUsd: 0.25, cachedTokens: 80 });
		total = addUsage(total, { promptTokens: 50, costUsd: 0.05, cachedTokens: 40 });
		expect(total.costUsd).toBeCloseTo(0.3);
		expect(total.cachedTokens).toBe(120);
	});
});

describe("addUsage com custo desconhecido", () => {
	it("soma costUnknownCalls e mantém o custo conhecido como parcial", () => {
		let total = addUsage(emptyUsage(), { promptTokens: 10, costUsd: 0.1 });
		total = addUsage(total, { promptTokens: 10, costUnknownCalls: 1 });
		total = addUsage(total, { promptTokens: 10, costUnknownCalls: 2 });
		expect(total.costUsd).toBeCloseTo(0.1);
		expect(total.costUnknownCalls).toBe(3);
	});

	it("tudo desconhecido: sem costUsd (não é 0) e com a contagem", () => {
		const total = addUsage(emptyUsage(), { promptTokens: 5, costUnknownCalls: 1 });
		expect(total.costUsd).toBeUndefined();
		expect(total.costUnknownCalls).toBe(1);
	});

	it("tudo conhecido não cria costUnknownCalls", () => {
		const total = addUsage(emptyUsage(), { promptTokens: 5, costUsd: 0.2 });
		expect(total).not.toHaveProperty("costUnknownCalls");
	});
});
