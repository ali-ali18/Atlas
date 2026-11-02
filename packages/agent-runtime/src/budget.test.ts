import { describe, expect, it } from "vitest";
import {
	addUsage,
	BUDGET_HARD_CAP,
	emptyUsage,
	parseBudgetPolicy,
	resolveBudget,
	wallClockAnchors,
} from "./budget.js";

describe("wallClockAnchors", () => {
	it("sem teto (0) ou infinito não há prazo: undefined, nunca Infinity (um timer com Infinity dispara na hora)", () => {
		for (const maxWallMs of [0, Number.POSITIVE_INFINITY]) {
			expect(wallClockAnchors({ maxWallMs, now: 1_000 }).deadlineAtMs).toBeUndefined();
		}
		expect(wallClockAnchors({ maxWallMs: 60_000, now: 1_000 }).deadlineAtMs).toBe(61_000);
	});
});

describe("resolveBudget", () => {
	it("padrão (decisão do dono, 02/11): sem soft de 24 passos e sem teto de relógio; só o teto de passos de segurança", () => {
		const budget = resolveBudget({});
		expect(budget.hardMaxSteps).toBe(BUDGET_HARD_CAP);
		// Soft = hard: não há fase de avaliação brando como freio.
		expect(budget.softMaxSteps).toBe(BUDGET_HARD_CAP);
		expect(budget.extensionSteps).toBe(24);
		expect(budget.maxWallMs).toBe(0);
		expect(budget.maxTokens).toBeUndefined();
	});

	it("o que o dono configura continua valendo: soft, relógio e custo", () => {
		const budget = resolveBudget({ policy: { softMaxSteps: 24, maxWallMs: 10 * 60_000, maxCostUsd: 2 } });
		expect(budget).toMatchObject({ softMaxSteps: 24, maxWallMs: 10 * 60_000, maxCostUsd: 2 });
		expect(resolveBudget({ policy: { maxWallMs: Number.NaN } }).maxWallMs).toBe(0);
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
