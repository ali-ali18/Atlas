// Cores dos gráficos do painel, por esquema (claro/escuro), em hex. Porta de `packages/ui/src/charts/chart-palettes.ts`
// (paletas prontas e personalizada) e dos tokens `--chart-1..6` de `globals.css` (visual padrão, sem paleta). O React
// Native não lê oklch: os valores abaixo são a conversão sRGB dos oklch do web, e `chart-palette.test.ts` refaz a
// conversão a partir do arquivo do web e falha se as tabelas divergirem.
import { CHART_CUSTOM_COLORS_MAX, normalizeChartHexColor, type ChartPalette, type PagePalette } from "@workspace/shared";
import { ensureContrast } from "./color-math";

export type ChartColors = {
	/** `--chart-1..6`: as cores das séries e das fatias, na ordem. */
	series: readonly [string, string, string, string, string, string];
	/** Tendência boa (verde) e ruim (vermelho): também são os tons `positive` e `critical` do painel. */
	positive: string;
	negative: string;
};

export type PresetPaletteId = Exclude<ChartPalette, "custom">;

const TREND = {
	light: { positive: "#00bc7d", negative: "#fb2c36" },
	dark: { positive: "#00d492", negative: "#ff6467" },
} as const;

type Series = ChartColors["series"];
const preset = (light: Series, dark: Series) => ({ light: { series: light, ...TREND.light }, dark: { series: dark, ...TREND.dark } });

export const PRESET_PALETTES: Record<PresetPaletteId, { light: ChartColors; dark: ChartColors }> = {
	primary: preset(["#615fff", "#fdc700", "#e12afb", "#67787c", "#000000", "#00bc7d"], ["#615fff", "#fdc700", "#e12afb", "#67787c", "#ffffff", "#00d492"]),
	monochrome: preset(["#292524", "#57534d", "#a6a09b", "#d6d3d1", "#e7e5e4", "#79716b"], ["#f4f4f5", "#d4d4d8", "#9f9fa9", "#71717b", "#52525c", "#3f3f46"]),
	ocean: preset(["#155dfc", "#00b8db", "#00d5be", "#7c86ff", "#74d4ff", "#8ec5ff"], ["#2b7fff", "#00d3f2", "#46ecd5", "#a3b3ff", "#b8e6fe", "#bedbff"]),
	sunset: preset(["#ff6900", "#ff2056", "#ffb900", "#ad46ff", "#fda5d5", "#fb2c36"], ["#ff8904", "#ff637e", "#ffd230", "#c27aff", "#fccee8", "#ff6467"]),
	grove: preset(["#009966", "#7ccf00", "#00786f", "#fe9a00", "#a6a09b", "#497d00"], ["#00d492", "#9ae600", "#009689", "#ffb900", "#a6a09b", "#5ea500"]),
	vivid: preset(["#8e51ff", "#f6339a", "#00b8db", "#7ccf00", "#ff6900", "#2b7fff"], ["#a684ff", "#fb64b6", "#53eafd", "#bbf451", "#ff8904", "#51a2ff"]),
};

/** Sem paleta: os tokens `--chart-1..6` de `globals.css` (azul, verde, âmbar, vermelho, roxo, ciano). */
export const DEFAULT_CHART_COLORS = {
	light: { series: ["#276ed2", "#2e9e52", "#c97500", "#d73337", "#8254c4", "#0f919c"], ...TREND.light },
	dark: { series: ["#65a7fa", "#5dc879", "#edb345", "#f66d67", "#b48df4", "#57c3cf"], ...TREND.dark },
} as const satisfies Record<"light" | "dark", ChartColors>;

/** Fundo do cartão em cada esquema (aproximação sRGB de `--card`), contra o qual a paleta personalizada é ajustada. */
const SURFACE = { light: "#ffffff", dark: "#18181b" } as const;

/** Âmbar fixo do tom `warning` (o web usa oklch(0.769 0.188 70.08) nos dois temas). */
export const WARNING_AMBER = "#fe9a00";

function customColors(scheme: "light" | "dark", input: readonly unknown[]): ChartColors | null {
	if (input.length < 1 || input.length > CHART_CUSTOM_COLORS_MAX) return null;
	const colors: string[] = [];
	for (const raw of input) {
		const hex = normalizeChartHexColor(raw);
		if (!hex) return null;
		colors.push(hex);
	}
	// Menos de 6 cores repetem em ciclo; cada uma é ajustada para ter contraste contra o fundo do esquema.
	const series = Array.from({ length: 6 }, (_, index) => ensureContrast(colors[index % colors.length]!, SURFACE[scheme])) as unknown as Series;
	return { series, ...TREND[scheme] };
}

/** Paleta de UM gráfico (`spec.palette`/`spec.colors`): ausente ou inválida = visual padrão. */
export function resolveChartColors(scheme: "light" | "dark", palette: ChartPalette | undefined, colors?: readonly string[]): ChartColors {
	if (!palette) return DEFAULT_CHART_COLORS[scheme];
	if (palette === "custom") return customColors(scheme, colors ?? []) ?? DEFAULT_CHART_COLORS[scheme];
	return PRESET_PALETTES[palette]?.[scheme] ?? DEFAULT_CHART_COLORS[scheme];
}

/** Paleta do PAINEL (`spec.palette`): id pronto ou `{ colors }`. */
export function resolvePageColors(scheme: "light" | "dark", palette: PagePalette | undefined): ChartColors {
	if (!palette) return DEFAULT_CHART_COLORS[scheme];
	return typeof palette === "string" ? resolveChartColors(scheme, palette) : resolveChartColors(scheme, "custom", palette.colors);
}

/**
 * Paleta que vale para um gráfico dentro do painel: a do próprio spec do gráfico vence a do painel (como no web, onde o
 * escopo `data-chart-palette` do gráfico fica dentro do do painel).
 */
export function colorsForChart(scheme: "light" | "dark", chart: { palette?: ChartPalette; colors?: readonly string[] }, page: ChartColors): ChartColors {
	return chart.palette ? resolveChartColors(scheme, chart.palette, chart.colors) : page;
}

/** Cor da série `index`: repete em ciclo a cada 6. */
export const seriesColor = (colors: ChartColors, index: number): string => colors.series[index % 6]!;
