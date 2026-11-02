import { PAGE_TONES } from "@workspace/shared";
import { describe, expect, it } from "vitest";
import { calloutTone, paletteAccent, toneColors } from "./page-tone";

const HEX = /^#[0-9a-f]{6}$/i;
const HEX_ALPHA = /^#[0-9a-f]{8}$/i;

describe("cores dos tons do painel", () => {
	it("todo tom tem cor nos dois esquemas, sempre em hex válido", () => {
		for (const scheme of ["dark", "light"] as const) {
			for (const tone of PAGE_TONES) {
				const colors = toneColors(scheme, tone);
				expect(colors.text).toMatch(HEX);
				expect(colors.fill).toMatch(HEX);
				expect(colors.soft).toMatch(HEX_ALPHA);
				expect(colors.edge).toMatch(HEX_ALPHA);
			}
		}
	});
	it("escuro: âmbar de aviso, verde de positivo, vermelho de crítico, laranja da marca, cinza neutro", () => {
		expect(toneColors("dark", "warning").text).toBe("#f7c243");
		expect(toneColors("dark", "positive").text).toBe("#52db9c");
		expect(toneColors("dark", "critical").text).toBe("#ff6467");
		expect(toneColors("dark", "accent").text).toBe("#fb923c");
		expect(toneColors("dark", "neutral").text).toBe("#9f9fa9");
	});
	it("claro: texto escuro o bastante para ler sobre branco", () => {
		expect(toneColors("light", "warning").text).toBe("#915200");
		expect(toneColors("light", "positive").text).toBe("#006a42");
		expect(toneColors("light", "accent").text).toBe("#c2410c");
	});
	it("sem tom = neutro; os tons não se confundem", () => {
		expect(toneColors("dark", undefined)).toEqual(toneColors("dark", "neutral"));
		const texts = PAGE_TONES.map((tone) => toneColors("dark", tone).text);
		expect(new Set(texts).size).toBe(PAGE_TONES.length);
	});
	it("o destaque segue a primeira cor da paleta custom, só se for hex válido", () => {
		expect(paletteAccent({ colors: ["#ABC", "#112233"] })).toBe("#aabbcc");
		expect(paletteAccent({ colors: ["red"] })).toBeNull();
		expect(paletteAccent({ colors: ["url(javascript:alert(1))"] })).toBeNull();
		expect(paletteAccent("ocean")).toBeNull();
		expect(paletteAccent(undefined)).toBeNull();
		expect(toneColors("dark", "accent", "#aabbcc").fill).toBe("#aabbcc");
		// a cor da paleta só vale para o tom de destaque
		expect(toneColors("dark", "critical", "#aabbcc").text).toBe("#ff6467");
	});
	it("aviso (callout) mapeia para o tom certo", () => {
		expect(calloutTone("info")).toBe("accent");
		expect(calloutTone("success")).toBe("positive");
		expect(calloutTone("warning")).toBe("warning");
		expect(calloutTone("critical")).toBe("critical");
	});
});
