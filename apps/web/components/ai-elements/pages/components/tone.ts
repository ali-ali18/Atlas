import type { PageCalloutTone, PageTone } from "@workspace/shared";

/**
 * Cores dos componentes do painel: SÓ tokens. O destaque (`accent`) é a `--chart-1` da paleta do painel e os tons
 * semânticos vêm dos tokens de tendência (positivo/negativo) e de um âmbar fixo para alerta. O componente define
 * `--tone` com `toneStyle` e usa as classes abaixo, que misturam a cor com o texto/fundo para manter o contraste.
 */
const TONE_COLOR: Record<PageTone, string> = {
	neutral: "var(--muted-foreground)",
	accent: "var(--chart-1)",
	positive: "var(--chart-positive)",
	warning: "oklch(0.769 0.188 70.08)",
	critical: "var(--chart-negative)",
};

const CALLOUT_TONE: Record<PageCalloutTone, PageTone> = { info: "accent", success: "positive", warning: "warning", critical: "critical" };

export const calloutTone = (tone: PageCalloutTone): PageTone => CALLOUT_TONE[tone];

/** `--tone` para o elemento (os filhos usam as classes `TONE_*`). */
export function toneStyle(tone: PageTone | undefined): React.CSSProperties {
	return { "--tone": TONE_COLOR[tone ?? "neutral"] } as React.CSSProperties;
}

/** Texto na cor do tom, misturado ao texto padrão para ficar legível nos dois temas. */
export const TONE_TEXT = "text-[color-mix(in_oklab,var(--tone)_72%,var(--foreground))]";
/** Fundo suave do tom. */
export const TONE_BG = "bg-[color-mix(in_oklab,var(--tone)_12%,transparent)]";
/** Borda do tom. */
export const TONE_BORDER = "border-[color-mix(in_oklab,var(--tone)_40%,transparent)]";
/** Preenchimento sólido (barras, pontos). */
export const TONE_FILL = "bg-[var(--tone)]";
