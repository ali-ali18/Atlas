// Idioma do aparelho (só o código curto: "pt", "es", "en"). O módulo nativo é lido com cuidado: fora do app (testes) ou
// sem o módulo, cai no pt-BR, o idioma do produto.

export const DEFAULT_LANGUAGE = "pt";

/** "pt-BR" / "pt_BR" / "PT" → "pt". Vazio ou inválido → `null`. */
export function languageCode(tag: string | null | undefined): string | null {
	const code = (tag ?? "").trim().toLowerCase().split(/[-_]/)[0] ?? "";
	return /^[a-z]{2,3}$/.test(code) ? code : null;
}

/** Idioma do aparelho. `locales` é injetável para teste. */
export function deviceLanguage(locales?: readonly { languageCode?: string | null; languageTag?: string | null }[]): string {
	try {
		// require tardio: o módulo nativo não carrega fora do app (vitest) e só é lido quando não há locales injetados
		const list = locales ?? (require("expo-localization") as typeof import("expo-localization")).getLocales();
		for (const locale of list) {
			const code = languageCode(locale.languageCode) ?? languageCode(locale.languageTag);
			if (code) return code;
		}
	} catch {
		// módulo nativo indisponível: segue o padrão
	}
	return DEFAULT_LANGUAGE;
}
