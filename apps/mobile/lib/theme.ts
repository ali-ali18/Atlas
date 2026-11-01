import { vars } from "nativewind";

/**
 * Tokens de cor portados de `packages/ui/src/styles/globals.css` (que usa oklch).
 * O React Native não lê oklch de forma confiável, então aqui estão convertidos para hex sRGB.
 * Mudou um token no web? Atualize aqui também (a ordem e os nomes são os mesmos).
 * `border` e `input` do tema escuro são branco a 10% e 15% no web; aqui vão pré-misturados sobre o
 * fundo (#222223 e #2e2e30), porque as variáveis de cor do RN são opacas (precisam de `/<alpha>`).
 */
export const colorTokens = {
	light: {
		background: "#ffffff",
		foreground: "#09090b",
		card: "#ffffff",
		"card-foreground": "#09090b",
		popover: "#ffffff",
		"popover-foreground": "#09090b",
		primary: "#18181b",
		"primary-foreground": "#fafafa",
		secondary: "#f4f4f5",
		"secondary-foreground": "#18181b",
		muted: "#f4f4f5",
		"muted-foreground": "#71717b",
		accent: "#f4f4f5",
		"accent-foreground": "#18181b",
		destructive: "#e7000b",
		border: "#e4e4e7",
		input: "#e4e4e7",
		success: "#006a42",
		"success-foreground": "#fafafa",
		warning: "#915200",
		"warning-foreground": "#fafafa",
		info: "#0068ad",
		"info-foreground": "#fafafa",
		ring: "#9f9fa9",
	},
	dark: {
		background: "#09090b",
		foreground: "#fafafa",
		card: "#18181b",
		"card-foreground": "#fafafa",
		popover: "#18181b",
		"popover-foreground": "#fafafa",
		primary: "#e4e4e7",
		"primary-foreground": "#18181b",
		secondary: "#27272a",
		"secondary-foreground": "#fafafa",
		muted: "#27272a",
		"muted-foreground": "#9f9fa9",
		accent: "#27272a",
		"accent-foreground": "#fafafa",
		destructive: "#ff6467",
		border: "#222223",
		input: "#2e2e30",
		success: "#52db9c",
		"success-foreground": "#031b10",
		warning: "#f7c243",
		"warning-foreground": "#291600",
		info: "#71c9fa",
		"info-foreground": "#051827",
		ring: "#71717b",
	},
} as const;

export type ColorScheme = keyof typeof colorTokens;
export type ColorToken = keyof (typeof colorTokens)["light"];

/** "#18181b" -> "24 24 27": canais para `rgb(var(--x) / <alpha-value>)`, que habilita `bg-muted/60`. */
export function hexToChannels(hex: string): string {
	const value = hex.replace("#", "");
	const channel = (start: number) => Number.parseInt(value.slice(start, start + 2), 16);
	return `${channel(0)} ${channel(2)} ${channel(4)}`;
}

/** Estilo que define as variáveis CSS (`--background`, …) lidas pelo tailwind.config.js. */
export function themeVars(scheme: ColorScheme) {
	const entries = Object.entries(colorTokens[scheme]).map(([name, value]) => [`--${name}`, hexToChannels(value)] as const);
	return vars(Object.fromEntries(entries));
}

export function themeColor(scheme: ColorScheme, token: ColorToken): string {
	return colorTokens[scheme][token];
}
