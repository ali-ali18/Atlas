import { describe, expect, it } from "vitest";
import { findTextPositions } from "./attachment-text.js";

describe("findTextPositions", () => {
	it("acha as posições sem diferenciar maiúsculas e respeita o limite", () => {
		expect(findTextPositions("Preço e preço e PREÇO", "preço", 0, 8)).toEqual([0, 8, 16]);
		expect(findTextPositions("Preço e preço e PREÇO", "preço", 0, 2)).toEqual([0, 8]);
	});

	it("começa a busca no deslocamento pedido (a próxima parte)", () => {
		expect(findTextPositions("ab ab ab", "ab", 3, 8)).toEqual([3, 6]);
		expect(findTextPositions("ab", "ab", 50, 8)).toEqual([]);
	});

	it("limites: busca vazia não acha nada; sem ocorrência é lista vazia", () => {
		expect(findTextPositions("abc", "", 0, 8)).toEqual([]);
		expect(findTextPositions("abc", "zz", 0, 8)).toEqual([]);
	});
});
