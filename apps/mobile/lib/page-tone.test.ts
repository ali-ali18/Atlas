import { PAGE_TONES } from "@workspace/shared";
import { describe, expect, it } from "vitest";
import { PRESET_PALETTES, WARNING_AMBER } from "./chart-palette";
import { mixHex } from "./color-math";
import { calloutTone, toneBase, toneColors } from "./page-tone";
import { colorTokens } from "./color-tokens";

const HEX = /^#[0-9a-f]{6}$/i;
const HEX_ALPHA = /^#[0-9a-f]{8}$/i;

describe("cores dos tons do painel (porte do tone.ts do web)", () => {
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
	it("a cor base de cada tom vem dos tokens: destaque = chart-1, positivo/crítico = tendência, aviso = âmbar, neutro = cinza", () => {
		expect(toneBase("dark", "accent", undefined)).toBe("#65a7fa");
		expect(toneBase("light", "accent", undefined)).toBe("#276ed2");
		expect(toneBase("dark", "positive", undefined)).toBe("#00d492");
		expect(toneBase("dark", "critical", undefined)).toBe("#ff6467");
		expect(toneBase("dark", "warning", undefined)).toBe(WARNING_AMBER);
		expect(toneBase("light", "warning", undefined)).toBe(WARNING_AMBER);
		expect(toneBase("dark", "neutral", undefined)).toBe(colorTokens.dark["muted-foreground"]);
	});
	it("texto = base 72% misturada ao texto padrão; fundo 12% e borda 40% da base", () => {
		const warning = toneColors("dark", "warning");
		expect(warning.text).toBe(mixHex(WARNING_AMBER, colorTokens.dark.foreground, 0.72));
		expect(warning.fill).toBe(WARNING_AMBER);
		expect(warning.soft).toBe(`${WARNING_AMBER}1f`);
		expect(warning.edge).toBe(`${WARNING_AMBER}66`);
	});
	it("sem tom = neutro; os tons não se confundem", () => {
		expect(toneColors("dark", undefined)).toEqual(toneColors("dark", "neutral"));
		expect(new Set(PAGE_TONES.map((tone) => toneColors("dark", tone).fill)).size).toBe(PAGE_TONES.length);
	});
	it("o destaque segue a paleta do painel (pronta ou própria); os outros tons só a tendência dela", () => {
		expect(toneBase("dark", "accent", "grove")).toBe(PRESET_PALETTES.grove.dark.series[0]);
		expect(toneBase("light", "accent", { colors: ["#2563eb"] })).toBe("#2563eb");
		expect(toneBase("dark", "warning", { colors: ["#2563eb"] })).toBe(WARNING_AMBER);
		expect(toneBase("dark", "critical", "grove")).toBe(PRESET_PALETTES.grove.dark.negative);
	});
	it("aviso (callout) mapeia para o tom certo", () => {
		expect(calloutTone("info")).toBe("accent");
		expect(calloutTone("success")).toBe("positive");
		expect(calloutTone("warning")).toBe("warning");
		expect(calloutTone("critical")).toBe("critical");
	});
});
