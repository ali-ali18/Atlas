// Cores dos tons do painel (neutral, positive, warning, critical, accent) por esquema. Hex fixo: o React Native não lê
// `color-mix` nem oklch. O texto vem do tom; o fundo e a borda são o preenchimento com transparência (sobre o
// cartão escuro ou claro continuam legíveis). Spec é dado não confiável: o tom só entra por esta tabela (nunca uma
// cor do spec direto) e a única cor livre, a da paleta `custom`, passa por `normalizeChartHexColor`.
import { normalizeChartHexColor, type PageCalloutTone, type PagePalette, type PageTone } from "@workspace/shared";

export type ToneColors = {
	/** Texto e ícone do tom. */
	text: string;
	/** Preenchimento sólido (barra, ponto, faixa). */
	fill: string;
	/** Fundo suave (cartão, selo). */
	soft: string;
	/** Contorno suave. */
	edge: string;
};

/** Laranja da marca (destaque padrão do painel quando a paleta não traz cor própria). */
const BRAND = { dark: "#fb923c", light: "#c2410c" } as const;

const BASE = {
	dark: { neutral: "#9f9fa9", positive: "#52db9c", warning: "#f7c243", critical: "#ff6467", accent: BRAND.dark },
	light: { neutral: "#71717b", positive: "#006a42", warning: "#915200", critical: "#e7000b", accent: BRAND.light },
} as const;

/** Preenchimento das barras no claro: mais vivo que o texto (que precisa de contraste sobre branco). */
const FILL_LIGHT: Record<PageTone, string> = { neutral: "#a1a1aa", positive: "#16a34a", warning: "#d97706", critical: "#e7000b", accent: "#ea580c" };

const hexAlpha = (hex: string, alpha: number): string => `${hex}${Math.round(alpha * 255).toString(16).padStart(2, "0")}`;

/** Destaque do painel: a primeira cor de uma paleta `custom` (validada) ou o laranja da marca. */
export function paletteAccent(palette: PagePalette | undefined): string | null {
	if (!palette || typeof palette === "string") return null;
	return normalizeChartHexColor(palette.colors[0]) ?? null;
}

export function toneColors(scheme: "light" | "dark", tone: PageTone | undefined, accentOverride?: string | null): ToneColors {
	const key = tone ?? "neutral";
	const accent = key === "accent" && accentOverride ? accentOverride : null;
	const text = accent ?? BASE[scheme][key];
	const fill = accent ?? (scheme === "dark" ? BASE.dark[key] : FILL_LIGHT[key]);
	return { text, fill, soft: hexAlpha(fill, key === "neutral" ? 0.12 : 0.14), edge: hexAlpha(fill, 0.4) };
}

const CALLOUT_TONE: Record<PageCalloutTone, PageTone> = { info: "accent", success: "positive", warning: "warning", critical: "critical" };

/** Tom de cada tipo de aviso (`callout`). */
export const calloutTone = (tone: PageCalloutTone): PageTone => CALLOUT_TONE[tone];
