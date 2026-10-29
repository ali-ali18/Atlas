/**
 * Escolha de idioma deste navegador (cookie). Parte pura (testável) + um gravador para o cliente.
 * Para ligar a uma configuração da conta no futuro, troque `writeUiLocalePreference` por uma chamada à
 * API e mantenha o cookie como cache; o resto (proxy, layout, provider) não muda.
 */
import {
	isUiLocalePreference,
	matchUiLocale,
	UI_LOCALE_COOKIE,
	UI_LOCALE_COOKIE_MAX_AGE,
	UI_LOCALE_PREF_COOKIE,
	DEFAULT_UI_LOCALE,
	type UiLocalePreference,
} from "./locales";

/** Lê a escolha de um `document.cookie`. Ausente ou inválida = "auto". */
export function parseLocalePreference(cookieString: string): UiLocalePreference {
	for (const part of cookieString.split(";")) {
		const [name, ...rest] = part.trim().split("=");
		if (name === UI_LOCALE_PREF_COOKIE) {
			try {
				const value = decodeURIComponent(rest.join("="));
				return isUiLocalePreference(value) ? value : "auto";
			} catch {
				// Cookie malformado (ex.: "%E0%A4%A"): trata como Automático em vez de quebrar a página.
				return "auto";
			}
		}
	}
	return "auto";
}

/** Linhas `Set-Cookie` (sem HttpOnly: o cliente grava) para aplicar a escolha. "auto" apaga a escolha. */
export function localePreferenceCookies(preference: UiLocalePreference, browserLanguages: readonly string[]): string[] {
	const base = "; Path=/; SameSite=Lax";
	if (preference === "auto") {
		const detected = matchUiLocale(browserLanguages) ?? DEFAULT_UI_LOCALE;
		return [
			`${UI_LOCALE_PREF_COOKIE}=; Max-Age=0${base}`,
			`${UI_LOCALE_COOKIE}=${detected}; Max-Age=${UI_LOCALE_COOKIE_MAX_AGE}${base}`,
		];
	}
	return [
		`${UI_LOCALE_PREF_COOKIE}=${preference}; Max-Age=${UI_LOCALE_COOKIE_MAX_AGE}${base}`,
		`${UI_LOCALE_COOKIE}=${preference}; Max-Age=${UI_LOCALE_COOKIE_MAX_AGE}${base}`,
	];
}

/** Grava a escolha no navegador. O chamador recarrega os dados do servidor (`router.refresh()`). */
export function writeUiLocalePreference(preference: UiLocalePreference): void {
	if (typeof document === "undefined") return;
	const languages = typeof navigator === "undefined" ? [] : navigator.languages ?? [navigator.language];
	for (const line of localePreferenceCookies(preference, languages)) document.cookie = line;
}

export function readUiLocalePreference(): UiLocalePreference {
	if (typeof document === "undefined") return "auto";
	return parseLocalePreference(document.cookie);
}
