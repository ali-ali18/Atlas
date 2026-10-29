/**
 * Idiomas da interface (não confundir com o idioma do bot, em `lib/bot-language.ts`).
 * Módulo puro: sem React, sem DOM, sem Next. Roda no proxy, no servidor, no cliente e em teste.
 *
 * Adicionar um idioma: acrescente o id em `UI_LOCALES`, o rótulo em `UI_LOCALE_LABELS` e
 * crie `messages/<id>/` (ver `README.md`). O typecheck aponta o que faltar.
 */

export const UI_LOCALES = ["pt-BR", "en-US", "es-ES"] as const;
export type UiLocale = (typeof UI_LOCALES)[number];

/** Idioma de origem dos textos (fonte da verdade) e último recurso da resolução. */
export const DEFAULT_UI_LOCALE: UiLocale = "pt-BR";

/** Nome de cada idioma escrito nele mesmo (não muda com o idioma da tela). */
export const UI_LOCALE_LABELS: Readonly<Record<UiLocale, string>> = {
	"pt-BR": "Português (Brasil)",
	"en-US": "English (US)",
	"es-ES": "Español (España)",
};

/** Escolha do usuário: um idioma fixo ou "auto" (segue o navegador). */
export type UiLocalePreference = UiLocale | "auto";

/** Cookie com a escolha explícita do usuário. Ausente = Automático. */
export const UI_LOCALE_PREF_COOKIE = "atlas-locale-pref";
export const UI_LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function isUiLocale(value: unknown): value is UiLocale {
	return typeof value === "string" && (UI_LOCALES as readonly string[]).includes(value);
}

export function isUiLocalePreference(value: unknown): value is UiLocalePreference {
	return value === "auto" || isUiLocale(value);
}

/** Tags do `Accept-Language` em ordem de preferência (maior `q` primeiro; empate mantém a ordem). */
export function parseAcceptLanguage(header: string | null | undefined): string[] {
	if (!header) return [];
	const entries: { tag: string; q: number; index: number }[] = [];
	header.split(",").forEach((part, index) => {
		const [rawTag, ...params] = part.trim().split(";");
		const tag = rawTag?.trim();
		if (!tag || tag === "*") return;
		let q = 1;
		for (const param of params) {
			const match = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(param);
			if (match) q = Number(match[1]);
		}
		if (!Number.isFinite(q) || q <= 0) return;
		entries.push({ tag, q, index });
	});
	return entries.sort((a, b) => b.q - a.q || a.index - b.index).map((entry) => entry.tag);
}

/** Primeiro idioma suportado entre as tags: casa a tag inteira, senão o idioma-base ("en-GB" -> en-US). */
export function matchUiLocale(tags: readonly string[]): UiLocale | null {
	for (const tag of tags) {
		const lower = tag.toLowerCase();
		const exact = UI_LOCALES.find((locale) => locale.toLowerCase() === lower);
		if (exact) return exact;
		const base = lower.split("-")[0];
		const byBase = UI_LOCALES.find((locale) => locale.toLowerCase().split("-")[0] === base);
		if (byBase) return byBase;
	}
	return null;
}

/**
 * Ordem de decisão: idioma da conta (futuro: configuração guardada no servidor) -> escolha deste
 * navegador (cookie) -> idioma do navegador (Accept-Language) -> pt-BR.
 */
export function resolveUiLocale(input: {
	accountLocale?: UiLocale | null;
	preference?: UiLocalePreference | null;
	acceptLanguage?: string | null;
}): UiLocale {
	if (input.accountLocale && isUiLocale(input.accountLocale)) return input.accountLocale;
	if (input.preference && isUiLocale(input.preference)) return input.preference;
	return matchUiLocale(parseAcceptLanguage(input.acceptLanguage)) ?? DEFAULT_UI_LOCALE;
}
