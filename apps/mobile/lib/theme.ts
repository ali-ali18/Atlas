import { vars } from "nativewind";

import { type ColorScheme, type ColorToken, colorTokens } from "./color-tokens";

// Os tokens vivem em `color-tokens.ts` (sem `nativewind`, para a lógica pura e os testes em node importarem); aqui só o que precisa do NativeWind.
export { type ColorScheme, type ColorToken, colorTokens };

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
