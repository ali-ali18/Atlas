import { describe, expect, it } from "vitest";
import { contrastRatio, ensureContrast, hexAlpha, hexToRgb, mixHex, relativeLuminance, rgbToHex } from "./color-math";

describe("contas de cor", () => {
	it("hex vai e volta, e a transparência vira os dois dígitos finais", () => {
		expect(hexToRgb("#fb923c")).toEqual([251, 146, 60]);
		expect(rgbToHex([251, 146, 60])).toBe("#fb923c");
		expect(rgbToHex([300, -4, 12.4])).toBe("#ff000c");
		expect(hexAlpha("#fb923c", 0.4)).toBe("#fb923c66");
		expect(hexAlpha("#fb923c", 0.12)).toBe("#fb923c1f");
		expect(hexAlpha("#fb923c", 2)).toBe("#fb923cff");
		// já com alfa: troca o alfa, não empilha
		expect(hexAlpha("#fb923c66", 0)).toBe("#fb923c00");
	});
	it("mistura como o color-mix: peso da primeira cor", () => {
		expect(mixHex("#000000", "#ffffff", 0.5)).toBe("#808080");
		expect(mixHex("#ff0000", "#0000ff", 1)).toBe("#ff0000");
		expect(mixHex("#ff0000", "#0000ff", 0)).toBe("#0000ff");
	});
	it("contraste: preto no branco é 21, igual não tem contraste", () => {
		expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
		expect(contrastRatio("#777777", "#777777")).toBeCloseTo(1, 5);
		expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 5);
	});
	it("ensureContrast escurece no claro, clareia no escuro e deixa em paz quem já passa", () => {
		expect(ensureContrast("#155dfc", "#ffffff")).toBe("#155dfc");
		const light = ensureContrast("#ffee00", "#ffffff");
		expect(contrastRatio(light, "#ffffff")).toBeGreaterThanOrEqual(3);
		expect(relativeLuminance(light)).toBeLessThan(relativeLuminance("#ffee00"));
		const dark = ensureContrast("#101040", "#18181b");
		expect(contrastRatio(dark, "#18181b")).toBeGreaterThanOrEqual(3);
		expect(relativeLuminance(dark)).toBeGreaterThan(relativeLuminance("#101040"));
	});
});
