import { describe, expect, it } from "vitest";
import {
	TOKEN_ESTIMATE_CHARS_PER_TOKEN,
	estimateTokens,
} from "./tokens.js";

describe("estimateTokens", () => {
	it("retorna 0 para texto vazio", () => {
		expect(estimateTokens("")).toBe(0);
	});

	it("estima pela regra chars/3.2", () => {
		const text = "x".repeat(32);
		expect(estimateTokens(text)).toBe(
			Math.ceil(32 / TOKEN_ESTIMATE_CHARS_PER_TOKEN),
		);
	});

	it("arredonda para cima com mínimo de 1", () => {
		expect(estimateTokens("oi")).toBe(1);
	});

	it("cresce linearmente com o texto", () => {
		const short = estimateTokens("a".repeat(100));
		const long = estimateTokens("a".repeat(1000));
		expect(long).toBeGreaterThan(short * 5);
	});
});
