import { describe, expect, it, vi } from "vitest";
import type { JevRuntime } from "./jev/decide.js";
import { classifyDifficultyWithReviewer, difficultyFromAnswers } from "./jev/difficulty.js";
import { buildTierPlan, modelsForTier, nextEscalationTier, repeatedWeakResults } from "./model-tiers.js";
import type { ToolOutcome } from "./progress.js";

describe("plano de níveis", () => {
	it("nível vazio herda o modelo do run e as reservas", () => {
		const plan = buildTierPlan({ hard: ["h/1", "h/2"] }, ["base/m", "base/r"]);
		expect(plan.easy).toEqual(["base/m", "base/r"]);
		expect(plan.hard).toEqual(["h/1", "h/2"]);
		expect(modelsForTier(plan, "easy")).toEqual({ model: "base/m", fallbacks: ["base/r"] });
		expect(modelsForTier(plan, "hard")).toEqual({ model: "h/1", fallbacks: ["h/2"] });
	});

	it("reservas só valem na rota do OpenRouter", () => {
		const plan = buildTierPlan({ easy: ["chatgpt/gpt-5", "o/x"], medium: ["o/a", "chatgpt/gpt-5", "o/b"] }, ["base/m"]);
		expect(modelsForTier(plan, "easy").fallbacks).toEqual([]);
		expect(modelsForTier(plan, "medium").fallbacks).toEqual(["o/b"]);
	});

	it("sobe para o próximo nível com modelo diferente; pula nível que repete o atual", () => {
		const plan = buildTierPlan({ easy: ["a/1"], medium: ["a/1"], hard: ["b/2"] }, ["base/m"]);
		expect(nextEscalationTier(plan, "easy", "a/1")).toBe("hard");
		expect(nextEscalationTier(plan, "hard", "b/2")).toBeNull();
	});

	it("sem nível mais forte (tudo igual ao atual) não sobe", () => {
		const plan = buildTierPlan({}, ["base/m"]);
		expect(nextEscalationTier(plan, "easy", "base/m")).toBeNull();
	});

	it("de Média para Difícil quando o Difícil é outro modelo", () => {
		const plan = buildTierPlan({ medium: ["a/1"], hard: ["b/2"] }, ["base/m"]);
		expect(nextEscalationTier(plan, "medium", "a/1")).toBe("hard");
	});
});

const outcome = (name: string, extra: Partial<ToolOutcome> = {}): ToolOutcome => ({
	name,
	argsKey: "{}",
	resultKey: "r",
	ok: true,
	...extra,
});

describe("repeatedWeakResults", () => {
	it("três falhas seguidas da mesma ferramenta pedem escalonamento", () => {
		const outcomes = [outcome("t", { ok: false, kind: "other" }), outcome("t", { ok: false, kind: "other" }), outcome("t", { ok: false, kind: "other" })];
		expect(repeatedWeakResults(outcomes, "t")).toBe(true);
		expect(repeatedWeakResults(outcomes.slice(0, 2), "t")).toBe(false);
	});

	it("três resultados vazios seguidos também", () => {
		const outcomes = [outcome("t", { empty: true }), outcome("t", { empty: true }), outcome("t", { empty: true })];
		expect(repeatedWeakResults(outcomes, "t")).toBe(true);
	});

	it("erro de argumento, sucesso no meio ou outra ferramenta não contam", () => {
		expect(repeatedWeakResults([outcome("t", { ok: false, kind: "argument" }), outcome("t", { ok: false, kind: "argument" }), outcome("t", { ok: false, kind: "argument" })], "t")).toBe(false);
		expect(repeatedWeakResults([outcome("t", { empty: true }), outcome("t"), outcome("t", { empty: true })], "t")).toBe(false);
		expect(repeatedWeakResults([outcome("a", { empty: true }), outcome("b", { empty: true }), outcome("a", { empty: true })], "a")).toBe(false);
	});

	it("depois de uma troca só conta o que veio depois dela", () => {
		const outcomes = [outcome("t", { empty: true }), outcome("t", { empty: true }), outcome("t", { empty: true }), outcome("t", { empty: true })];
		expect(repeatedWeakResults(outcomes, "t", 3)).toBe(false);
		expect(repeatedWeakResults(outcomes, "t", 1)).toBe(true);
	});
});

describe("classificação pelo revisor", () => {
	const jev = (answers: Record<string, number> | Error, ask = vi.fn()): JevRuntime => ({
		ask: ask.mockImplementation(async () => {
			if (answers instanceof Error) throw answers;
			return { model: "jev", answers, durationMs: 1 };
		}),
	});

	it("probabilidades viram nível", () => {
		expect(difficultyFromAnswers({ hard: 0.9, medium: 0.9 })).toBe("hard");
		expect(difficultyFromAnswers({ hard: 0.1, medium: 0.8 })).toBe("medium");
		expect(difficultyFromAnswers({ hard: 0.1, medium: 0.2 })).toBe("easy");
	});

	it("uma única chamada ao revisor, com o pedido recortado", async () => {
		const ask = vi.fn();
		const result = await classifyDifficultyWithReviewer({ rt: jev({ hard: 0.1, medium: 0.9 }, ask), request: "me mostra as vendas" });
		expect(result).toEqual({ tier: "medium", reason: "reviewer" });
		expect(ask).toHaveBeenCalledTimes(1);
		expect(Object.keys(ask.mock.calls[0]![0].questions).sort()).toEqual(["hard", "medium"]);
	});

	it("erro, resposta malformada ou sem revisor devolvem null (cai nas regras)", async () => {
		expect(await classifyDifficultyWithReviewer({ rt: jev(new Error("fora do ar")), request: "oi" })).toBeNull();
		expect(await classifyDifficultyWithReviewer({ rt: jev({ hard: 2, medium: 0 }), request: "oi" })).toBeNull();
		expect(await classifyDifficultyWithReviewer({ rt: jev({ medium: 0.5 }), request: "oi" })).toBeNull();
		expect(await classifyDifficultyWithReviewer({ rt: undefined, request: "oi" })).toBeNull();
		expect(await classifyDifficultyWithReviewer({ rt: {}, request: "oi" })).toBeNull();
	});

	it("o cancelamento do usuário propaga", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			classifyDifficultyWithReviewer({ rt: jev(new Error("abort")), request: "oi", signal: controller.signal }),
		).rejects.toThrow();
	});
});
