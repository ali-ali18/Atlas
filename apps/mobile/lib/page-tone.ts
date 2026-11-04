// Cores dos tons do painel (neutral, positive, warning, critical, accent) por esquema, em hex. Porta de
// `apps/web/components/ai-elements/pages/components/tone.ts`: a cor base do tom vem dos tokens (accent = `--chart-1` da
// paleta do painel, positive/critical = tendência da paleta, warning = âmbar fixo, neutral = `muted-foreground`), o texto
// é a base misturada 72% ao `foreground`, o fundo é a base a 12% e a borda a 40%. O React Native não lê `color-mix`,
// então a mistura é feita aqui. Spec é dado não confiável: o tom só entra por esta tabela (nunca uma cor do spec direto).
import type { PageCalloutTone, PagePalette, PageTone } from "@workspace/shared";
import { hexAlpha, mixHex } from "./color-math";
import { resolvePageColors, WARNING_AMBER } from "./chart-palette";
import { colorTokens } from "./color-tokens";

export type ToneColors = {
	/** Texto e ícone do tom (a cor base misturada ao texto padrão, para ler nos dois temas). */
	text: string;
	/** Cor base: barra, ponto, faixa, ícone. */
	fill: string;
	/** Fundo suave (cartão, selo, aviso). */
	soft: string;
	/** Contorno suave. */
	edge: string;
};

/** Cor base de um tom (o `TONE_COLOR` do web). */
export function toneBase(scheme: "light" | "dark", tone: PageTone | undefined, palette: PagePalette | undefined): string {
	const colors = resolvePageColors(scheme, palette);
	switch (tone ?? "neutral") {
		case "accent":
			return colors.series[0];
		case "positive":
			return colors.positive;
		case "critical":
			return colors.negative;
		case "warning":
			return WARNING_AMBER;
		default:
			return colorTokens[scheme]["muted-foreground"];
	}
}

export function toneColors(scheme: "light" | "dark", tone: PageTone | undefined, palette?: PagePalette): ToneColors {
	const base = toneBase(scheme, tone, palette);
	return { text: mixHex(base, colorTokens[scheme].foreground, 0.72), fill: base, soft: hexAlpha(base, 0.12), edge: hexAlpha(base, 0.4) };
}

const CALLOUT_TONE: Record<PageCalloutTone, PageTone> = { info: "accent", success: "positive", warning: "warning", critical: "critical" };

/** Tom de cada tipo de aviso (`callout`). */
export const calloutTone = (tone: PageCalloutTone): PageTone => CALLOUT_TONE[tone];
