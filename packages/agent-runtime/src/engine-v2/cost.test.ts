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
	it("cota de plano (nem custo nem 'desconhecido') não custa nada", () => {
		expect(callCostUsd({ promptTokens: 5000, completionTokens: 500 })).toEqual({ costUsd: 0, estimated: false });
	});
	it("preço configurável por ambiente; valor inválido cai no padrão", () => {
		expect(fallbackPricesFromEnv({ ATLAS_V2_FALLBACK_PROMPT_USD_PER_MTOK: "1", ATLAS_V2_FALLBACK_COMPLETION_USD_PER_MTOK: "x" })).toEqual({ promptUsdPerMTok: 1, completionUsdPerMTok: 15 });
	});
});
