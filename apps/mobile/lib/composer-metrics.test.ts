import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { COMPOSER_LINE_HEIGHT, COMPOSER_STACKED_STRIP, fieldWrapperStyle, textWrapped, webFieldHeight } from "./composer-metrics";

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

describe("altura do campo", () => {
	it("na web cresce com o conteúdo entre o mínimo e o teto", () => {
		expect(webFieldHeight(21, 45, 300)).toBe(45);
		expect(webFieldHeight(21 * 6 + 24, 45, 300)).toBe(150);
		expect(webFieldHeight(21 * 15 + 24, 45, 300)).toBe(300);
	});
	it("o flex fica no envoltório", () => {
		expect(fieldWrapperStyle(false)).toEqual({ flex: 1 });
		expect(fieldWrapperStyle(true)).toMatchObject({ flexBasis: 120, minWidth: 120 });
	});
	it("o TextInput não tem flex: dentro do envoltório de altura automática ele trava em minHeight e rola (regressão)", () => {
		const src = readFileSync(resolve(__dirname, "../components/chat/composer.tsx"), "utf8");
		const input = src.slice(src.indexOf("<TextInput"), src.indexOf("</PasteImageInput>"));
		expect(input).toContain("maxHeight: maxFieldHeight");
		expect(input).not.toMatch(/\bflex(Grow|Shrink|Basis)?:/);
	});
});
