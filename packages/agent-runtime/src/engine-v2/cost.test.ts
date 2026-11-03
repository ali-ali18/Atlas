import { describe, expect, it } from "vitest";
import { DEFAULT_FALLBACK_PRICES, callCostUsd, estimateCostUsd, fallbackPricesFromEnv } from "./cost.js";

describe("custo do orçamento", () => {
	it("usa o custo informado e, sem ele, estima pelos tokens com preço conservador", () => {
		expect(callCostUsd({ costUsd: 0.02, promptTokens: 1000, completionTokens: 100 })).toEqual({ costUsd: 0.02, estimated: false });
		const unknown = callCostUsd({ costUnknownCalls: 1, promptTokens: 100_000, completionTokens: 10_000 });
		expect(unknown.estimated).toBe(true);
		expect(unknown.costUsd).toBeCloseTo(0.3 + 0.15, 6);
		expect(estimateCostUsd({ promptTokens: 1_000_000, completionTokens: 0 })).toBe(DEFAULT_FALLBACK_PRICES.promptUsdPerMTok);
	});
	it("desconta os tokens em cache quando o provedor não informa o custo (a estimativa não cobra o prompt inteiro)", () => {
		const full = callCostUsd({ costUnknownCalls: 1, promptTokens: 100_000, completionTokens: 0 });
		const cached = callCostUsd({ costUnknownCalls: 1, promptTokens: 100_000, cachedTokens: 80_000, completionTokens: 0 });
		// 20k a preço cheio + 80k a 25%: (20k + 20k) * US$ 3/M = US$ 0,12 em vez de US$ 0,30.
		expect(full.costUsd).toBeCloseTo(0.3, 6);
		expect(cached.costUsd).toBeCloseTo(0.12, 6);
		expect(cached.estimated).toBe(true);
		// Cache maior que o prompt é limitado ao prompt; custo informado pelo provedor vence sempre.
		expect(callCostUsd({ costUnknownCalls: 1, promptTokens: 1000, cachedTokens: 9999, completionTokens: 0 }).costUsd).toBeCloseTo(0.00075, 8);
		expect(callCostUsd({ costUsd: 0.5, promptTokens: 100_000, cachedTokens: 90_000, completionTokens: 0 })).toEqual({ costUsd: 0.5, estimated: false });
		expect(estimateCostUsd({ promptTokens: 1_000_000, cachedTokens: 1_000_000, completionTokens: 0 }, { promptUsdPerMTok: 3, completionUsdPerMTok: 15, cachedPromptRatio: 0.1 })).toBeCloseTo(0.3, 6);
	});
	it("cota de plano (nem custo nem 'desconhecido') não custa nada", () => {
		expect(callCostUsd({ promptTokens: 5000, completionTokens: 500 })).toEqual({ costUsd: 0, estimated: false });
	});
	it("preço configurável por ambiente; valor inválido cai no padrão", () => {
		expect(fallbackPricesFromEnv({ ATLAS_V2_FALLBACK_PROMPT_USD_PER_MTOK: "1", ATLAS_V2_FALLBACK_COMPLETION_USD_PER_MTOK: "x" })).toEqual({ promptUsdPerMTok: 1, completionUsdPerMTok: 15, cachedPromptRatio: 0.25 });
	});
});
