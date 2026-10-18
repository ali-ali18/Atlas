import { describe, expect, it } from "vitest";
import { isCreditsExhaustedText, isProviderExhaustedStatus, isProviderExhaustedText } from "./provider-exhausted.js";

describe("isProviderExhaustedText", () => {
	it("reconhece créditos, cota e rate limit (mensagens reais do conector)", () => {
		for (const text of [
			"[Firecrawl] Request failed with status code 402",
			"[Firecrawl] Insufficient credits to perform this request.",
			"The connected account is low on credits.",
			"HTTP 429 Too Many Requests",
			"Monthly quota exceeded",
			"rate limit reached, retry later",
		]) {
			expect(isProviderExhaustedText(text), text).toBe(true);
		}
	});

	it("não confunde falha de uma página com provedor esgotado", () => {
		for (const text of ["All scraping engines failed for this URL", "timeout after 30000ms", "HTTP 404 not found", "página exige login"]) {
			expect(isProviderExhaustedText(text), text).toBe(false);
		}
	});
});

describe("isCreditsExhaustedText", () => {
	it("créditos/cota sim; rate limit passageiro não", () => {
		expect(isCreditsExhaustedText("Insufficient credits to perform this request")).toBe(true);
		expect(isCreditsExhaustedText("Request failed with status code 402")).toBe(true);
		expect(isCreditsExhaustedText("429 Too Many Requests")).toBe(false);
	});
});

describe("isProviderExhaustedStatus", () => {
	it("401/402/403/429 esgotam; 404 e 5xx não", () => {
		for (const status of [401, 402, 403, 429]) expect(isProviderExhaustedStatus(status)).toBe(true);
		for (const status of [200, 404, 500, 503, undefined]) expect(isProviderExhaustedStatus(status)).toBe(false);
	});
});
