import { CHART_PALETTES } from "@workspace/shared";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// Fonte da verdade das cores: o próprio arquivo do web (oklch). O teste converte e compara com as tabelas em hex do app.
import { CHART_PALETTE_LABELS, PRESET_PALETTES as WEB_PRESETS } from "../../../packages/ui/src/charts/chart-palettes";
import { colorsForChart, DEFAULT_CHART_COLORS, PRESET_PALETTES, resolveChartColors, resolvePageColors, seriesColor, WARNING_AMBER } from "./chart-palette";
import { contrastRatio, hexToRgb } from "./color-math";
import { colorTokens } from "./color-tokens";

/** oklch(L C H) -> #rrggbb (OKLab -> sRGB linear -> gama), o mesmo caminho do navegador. */
function oklchToHex(css: string): string {
	const match = /oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(css);
	if (!match) throw new Error(`oklch inválido: ${css}`);
	const L = Number(match[1]);
	const hue = (Number(match[3]) * Math.PI) / 180;
	const a = Number(match[2]) * Math.cos(hue);
	const b = Number(match[2]) * Math.sin(hue);
	const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
	const linear = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
	const encode = (v: number) => {
		const c = Math.min(1, Math.max(0, v));
		return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
	};
	return `#${linear.map((v) => Math.round(encode(v) * 255).toString(16).padStart(2, "0")).join("")}`;
}

describe("paletas dos gráficos (porte do web)", () => {
	it("o conversor acerta cores conhecidas", () => {
		expect(oklchToHex("oklch(1 0 0)")).toBe("#ffffff");
		expect(oklchToHex("oklch(0 0 0)")).toBe("#000000");
		expect(oklchToHex("oklch(0.585 0.233 277.117)")).toBe("#615fff");
	});
	it("cada paleta pronta, nos dois esquemas, é exatamente a conversão do arquivo do web", () => {
		for (const id of Object.keys(WEB_PRESETS) as Array<keyof typeof WEB_PRESETS>) {
			for (const scheme of ["light", "dark"] as const) {
				const web = WEB_PRESETS[id][scheme];
				const app = PRESET_PALETTES[id][scheme];
				expect([id, scheme, [...app.series]]).toEqual([id, scheme, web.series.map(oklchToHex)]);
				expect(app.positive).toBe(oklchToHex(web.positive));
				expect(app.negative).toBe(oklchToHex(web.negative));
			}
		}
	});
	it("o app tem todas as paletas prontas do shared (e só elas), com nome de exibição no web", () => {
		expect(Object.keys(PRESET_PALETTES).sort()).toEqual(CHART_PALETTES.filter((id) => id !== "custom").sort());
		expect(Object.keys(CHART_PALETTE_LABELS).sort()).toEqual(Object.keys(PRESET_PALETTES).sort());
	});
	it("sem paleta valem os tokens --chart-1..6 do globals.css", () => {
		expect(DEFAULT_CHART_COLORS.dark.series[0]).toBe(oklchToHex("oklch(0.72 0.14 255)"));
		expect(DEFAULT_CHART_COLORS.light.series[0]).toBe(oklchToHex("oklch(0.55 0.17 258)"));
		expect(DEFAULT_CHART_COLORS.dark.series[2]).toBe(oklchToHex("oklch(0.8 0.14 80)"));
		expect(resolveChartColors("dark", undefined)).toBe(DEFAULT_CHART_COLORS.dark);
	});
	it("paleta custom: hex normalizado, ciclo de 6 e contraste mínimo contra o fundo do esquema", () => {
		const light = resolveChartColors("light", "custom", ["#FFEE00", "#2563eb"]);
		expect(light.series).toHaveLength(6);
		expect(light.series[2]).toBe(light.series[0]);
		expect(light.series[3]).toBe(light.series[1]);
		for (const color of light.series) expect(contrastRatio(color, "#ffffff")).toBeGreaterThanOrEqual(3);
		const dark = resolveChartColors("dark", "custom", ["#101040"]);
		for (const color of dark.series) expect(contrastRatio(color, "#18181b")).toBeGreaterThanOrEqual(3);
	});
	it("custom inválida (sem cores, cor ruim, cores demais) cai no padrão, nunca em cor do spec", () => {
		expect(resolveChartColors("dark", "custom", [])).toBe(DEFAULT_CHART_COLORS.dark);
		expect(resolveChartColors("dark", "custom", ["red"])).toBe(DEFAULT_CHART_COLORS.dark);
		expect(resolveChartColors("dark", "custom", Array(7).fill("#112233"))).toBe(DEFAULT_CHART_COLORS.dark);
	});
	it("paleta do painel: id pronto ou { colors }", () => {
		expect(resolvePageColors("dark", "ocean")).toBe(PRESET_PALETTES.ocean.dark);
		expect(resolvePageColors("light", { colors: ["#2563eb"] }).series[0]).toBe("#2563eb");
		expect(resolvePageColors("dark", undefined)).toBe(DEFAULT_CHART_COLORS.dark);
	});
	it("a paleta do próprio gráfico vence a do painel", () => {
		const page = resolvePageColors("dark", "grove");
		expect(colorsForChart("dark", {}, page)).toBe(page);
		expect(colorsForChart("dark", { palette: "sunset" }, page)).toBe(PRESET_PALETTES.sunset.dark);
	});
	it("a cor da série repete em ciclo", () => {
		expect(seriesColor(DEFAULT_CHART_COLORS.dark, 0)).toBe(seriesColor(DEFAULT_CHART_COLORS.dark, 6));
	});
});

/** Tokens `--nome: oklch(...)` de um bloco (`:root` ou `.dark`) do globals.css do web. */
function webTokens(block: ":root" | ".dark"): Record<string, string> {
	const css = readFileSync(join(process.cwd(), "../../packages/ui/src/styles/globals.css"), "utf8");
	const start = css.indexOf(`\n${block} {`);
	const body = css.slice(start, css.indexOf("\n}", start));
	return Object.fromEntries([...body.matchAll(/--([a-z0-9-]+):\s*(oklch\([^)]*\))/g)].map((match) => [match[1]!, match[2]!]));
}

/** As contas de oklch -> hex arredondam diferente em 1 nível; mais que 2 é cor diferente. */
function near(actual: string, expected: string, label: string) {
	const a = hexToRgb(actual);
	const b = hexToRgb(expected);
	expect(Math.max(...a.map((channel, index) => Math.abs(channel - b[index]!))), `${label}: ${actual} x ${expected}`).toBeLessThanOrEqual(2);
}

describe("o app segue o globals.css do web (lido do arquivo)", () => {
	for (const [scheme, block] of [["light", ":root"], ["dark", ".dark"]] as const) {
		it(`${scheme}: --chart-1..6, tendência e superfícies`, () => {
			const web = webTokens(block);
			DEFAULT_CHART_COLORS[scheme].series.forEach((color, index) => near(color, oklchToHex(web[`chart-${index + 1}`]!), `chart-${index + 1}`));
			near(DEFAULT_CHART_COLORS[scheme].positive, oklchToHex(web["chart-positive"]!), "chart-positive");
			near(DEFAULT_CHART_COLORS[scheme].negative, oklchToHex(web["chart-negative"]!), "chart-negative");
			for (const token of ["background", "foreground", "card", "popover", "muted", "muted-foreground"] as const) {
				if (web[token]) near(colorTokens[scheme][token], oklchToHex(web[token]!), token);
			}
		});
	}
	it("o âmbar do tom de aviso é o do tone.ts do web", () => {
		const source = readFileSync(join(process.cwd(), "../web/components/ai-elements/pages/components/tone.ts"), "utf8");
		const amber = /warning: "(oklch\([^"]+\))"/.exec(source)?.[1];
		expect(amber).toBeDefined();
		near(WARNING_AMBER, oklchToHex(amber!), "warning");
	});
});
