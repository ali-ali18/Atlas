import { describe, expect, it } from "vitest";
import {
	availableWebFallbacks,
	budgetUsedFraction,
	createProviderHealth,
	exhaustedBlockedMessage,
	exhaustedNotice,
	isApiProviderExhausted,
	shouldContinueAfterExhaustion,
} from "./provider-health.js";

describe("createProviderHealth", () => {
	it("avisa só na primeira marcação e mantém o estado", () => {
		const health = createProviderHealth();
		expect(health.any()).toBe(false);
		expect(health.markExhausted("a")).toBe(true);
		expect(health.markExhausted("a")).toBe(false);
		expect(health.isExhausted("a")).toBe(true);
		expect(health.isExhausted("b")).toBe(false);
		expect(health.any()).toBe(true);
	});
});

describe("avisos ao modelo", () => {
	it("citam só alternativas que existem no run", () => {
		const has = (name: string) => name === "web_search" || name === "web_extract";
		expect(availableWebFallbacks(has)).toEqual(["web_search", "web_extract"]);
		expect(exhaustedNotice("Firecrawl", ["web_search", "web_extract"])).toContain("Continue the same work with web_search, web_extract.");
		expect(exhaustedBlockedMessage("Firecrawl", ["navigate"])).toContain("Continue the same work with navigate.");
	});

	it("sem alternativa, manda dizer honestamente o que ficou sem cobertura", () => {
		expect(exhaustedNotice("X", [])).toContain("say plainly what could not be covered");
	});
});

describe("isApiProviderExhausted", () => {
	it("402/429/401 e texto de cota esgotam; 500 e 404 não", () => {
		expect(isApiProviderExhausted("extração falhou em https://a.com (HTTP 402)")).toBe(true);
		expect(isApiProviderExhausted("busca falhou (HTTP 429)")).toBe(true);
		expect(isApiProviderExhausted("extração falhou (HTTP 401)")).toBe(true);
		expect(isApiProviderExhausted("busca falhou (HTTP 500): Insufficient credits")).toBe(true);
		expect(isApiProviderExhausted("extração falhou em https://a.com (HTTP 500)")).toBe(false);
		expect(isApiProviderExhausted("extração falhou em https://a.com (HTTP 404)")).toBe(false);
	});
});

describe("budgetUsedFraction / shouldContinueAfterExhaustion", () => {
	it("usa o maior consumo e ignora tetos ausentes", () => {
		expect(budgetUsedFraction({ step: 10, maxSteps: 100 })).toBe(0.1);
		expect(budgetUsedFraction({ step: 10, maxSteps: 100, tokens: 900, maxTokens: 1000, wallMs: 5, maxWallMs: 0 })).toBe(0.9);
	});

	it("cutuca só com provedor esgotado, alternativa, folga (<80%) e uma única vez", () => {
		const base = { anyExhausted: true, alternatives: ["web_search"], alreadyNudged: false, usedFraction: 0.5 };
		expect(shouldContinueAfterExhaustion(base)).toBe(true);
		expect(shouldContinueAfterExhaustion({ ...base, anyExhausted: false })).toBe(false);
		expect(shouldContinueAfterExhaustion({ ...base, alternatives: [] })).toBe(false);
		expect(shouldContinueAfterExhaustion({ ...base, alreadyNudged: true })).toBe(false);
		expect(shouldContinueAfterExhaustion({ ...base, usedFraction: 0.8 })).toBe(false);
	});
});
