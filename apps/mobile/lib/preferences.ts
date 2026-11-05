// Preferências deste aparelho (aparência, retorno tátil, fuso automático). Só decisão pura: ler/gravar fica em
// `preferences-store.ts` e o estado vivo em `app-preferences.tsx`. Nada daqui vai para o servidor.
import type { ColorScheme } from "./color-tokens";

export const THEME_PREFERENCES = ["system", "light", "dark"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

/** Cor de destaque da interface (botão enviar, interruptores): `neutral` = foreground/background do tema; `bot` = a cor do bot (o comportamento de sempre). */
export const ACCENT_PREFERENCES = ["neutral", "bot"] as const;
export type AccentPreference = (typeof ACCENT_PREFERENCES)[number];

export type Preferences = {
	theme: ThemePreference;
	accent: AccentPreference;
	/** Retorno tátil ligado (padrão: ligado). */
	haptics: boolean;
	/** Fuso automático escolhido de propósito; `null` = nunca escolheu (vale a inferência de `isAutoTimezone`). */
	autoTimezone: boolean | null;
};

export const DEFAULT_PREFERENCES: Preferences = { theme: "system", accent: "bot", haptics: true, autoTimezone: null };

const THEME_LABELS: Record<ThemePreference, string> = { system: "Sistema", light: "Claro", dark: "Escuro" };

export const themePreferenceLabel = (theme: ThemePreference): string => THEME_LABELS[theme];

export const THEME_OPTIONS: readonly { value: ThemePreference; label: string }[] = THEME_PREFERENCES.map((value) => ({ value, label: THEME_LABELS[value] }));

const ACCENT_LABELS: Record<AccentPreference, string> = { neutral: "Neutro", bot: "Cor do bot" };

export const accentPreferenceLabel = (accent: AccentPreference): string => ACCENT_LABELS[accent];

export function isAccentPreference(value: unknown): value is AccentPreference {
	return typeof value === "string" && (ACCENT_PREFERENCES as readonly string[]).includes(value);
}

/** Destaque que vale: o do bot ou, em "Neutro", o par neutro do tema (botão claro com ícone escuro no escuro, e o inverso no claro). */
export function resolveAccent<T>(accent: AccentPreference, bot: T, neutral: T): T {
	return accent === "neutral" ? neutral : bot;
}

export function isThemePreference(value: unknown): value is ThemePreference {
	return typeof value === "string" && (THEME_PREFERENCES as readonly string[]).includes(value);
}

/** Tema que vale: a escolha do dono ou, em "Sistema" (ou sem escolha), o do aparelho; sem nenhum dos dois, o claro. */
export function resolveColorScheme(theme: ThemePreference, system: string | null | undefined): ColorScheme {
	if (theme === "light" || theme === "dark") return theme;
	return system === "dark" ? "dark" : "light";
}

/** Lê o JSON guardado no aparelho; qualquer campo ausente ou estranho volta ao padrão (arquivo corrompido nunca derruba o app). */
export function parsePreferences(raw: string | null | undefined): Preferences {
	if (!raw) return DEFAULT_PREFERENCES;
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return DEFAULT_PREFERENCES;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return DEFAULT_PREFERENCES;
	const record = value as Record<string, unknown>;
	return {
		theme: isThemePreference(record.theme) ? record.theme : DEFAULT_PREFERENCES.theme,
		accent: isAccentPreference(record.accent) ? record.accent : DEFAULT_PREFERENCES.accent,
		haptics: typeof record.haptics === "boolean" ? record.haptics : DEFAULT_PREFERENCES.haptics,
		autoTimezone: typeof record.autoTimezone === "boolean" ? record.autoTimezone : null,
	};
}

export function serializePreferences(preferences: Preferences): string {
	return JSON.stringify({ theme: preferences.theme, accent: preferences.accent, haptics: preferences.haptics, autoTimezone: preferences.autoTimezone });
}
