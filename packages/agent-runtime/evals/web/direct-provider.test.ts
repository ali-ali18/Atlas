import { describe, expect, it } from "vitest";
import { directApiKey, directCostUsd } from "./direct-provider.js";

describe("direct-provider: custo do Anthropic direto", () => {
	it("Haiku 5.5: 0,10 entrada e 0,50 saída por milhão", () => {
		expect(directCostUsd("claude-haiku-5-5", { promptTokens: 100_000, completionTokens: 100_000 })).toBeCloseTo(0.06, 8);
	});
	it("cache lido custa 0,1x e gravado 1,25x", () => {
		expect(directCostUsd("claude-haiku-5-5", { promptTokens: 100_000, cachedTokens: 50_000, cacheWriteTokens: 10_000 })).toBeCloseTo((40_000 + 5_000 + 12_500) * 0.1 / 1_000_000, 8);
	});
	it("chamada acima de 100 mil tokens de entrada usa a tarifa de contexto longo", () => {
		expect(directCostUsd("claude-haiku-5-5", { promptTokens: 200_000, completionTokens: 1000 })).toBeCloseTo((200_000 * 0.5 + 1000 * 2.5) / 1_000_000, 8);
	});
	it("modelo fora da tabela usa o preço de reserva, nunca 0", () => {
		expect(directCostUsd("desconhecido", { promptTokens: 1_000_000 })).toBeCloseTo(3, 6);
	});
	it("a chave vem de CLAUDE_KEY ou ANTHROPIC_API_KEY", () => {
		expect(directApiKey({ CLAUDE_KEY: " a " })).toBe("a");
		expect(directApiKey({ ANTHROPIC_API_KEY: "b" })).toBe("b");
		expect(directApiKey({})).toBe("");
	});
});
