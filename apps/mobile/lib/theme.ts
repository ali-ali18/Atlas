import { vars } from "nativewind";

import { type ColorScheme, colorTokens } from "./color-tokens";

// Os valores moram em `color-tokens.ts` (puro, testável sem o NativeWind); aqui ficam as variáveis CSS do NativeWind.
export { type ColorScheme, type ColorToken, colorTokens, themeColor } from "./color-tokens";

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
