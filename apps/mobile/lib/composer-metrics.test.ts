import { describe, expect, it } from "vitest";
import { COMPOSER_LINE_HEIGHT, COMPOSER_STACKED_STRIP, textWrapped } from "./composer-metrics";

describe("textWrapped", () => {
	it("uma linha não empilha", () => {
		expect(textWrapped(COMPOSER_LINE_HEIGHT, COMPOSER_LINE_HEIGHT)).toBe(false);
		expect(textWrapped(0, 0)).toBe(false);
	});
	it("duas ou mais linhas empilham", () => {
		expect(textWrapped(COMPOSER_LINE_HEIGHT * 2, COMPOSER_LINE_HEIGHT)).toBe(true);
		expect(textWrapped(COMPOSER_LINE_HEIGHT * 5, COMPOSER_LINE_HEIGHT)).toBe(true);
	});
	it("respeita a base medida (campo com altura de uma linha diferente)", () => {
		expect(textWrapped(40, 40)).toBe(false);
		expect(textWrapped(61, 40)).toBe(true);
		expect(textWrapped(55, 40)).toBe(false);
	});
	it("a faixa dos botões é o botão mais o respiro dos dois lados", () => {
		expect(COMPOSER_STACKED_STRIP).toBe(50);
	});
});
