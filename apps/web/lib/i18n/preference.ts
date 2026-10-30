/**
 * Escolha de idioma deste navegador (cookie). Parte pura (testável) + um gravador para o cliente.
 * Para ligar a uma configuração da conta no futuro, troque `writeUiLocalePreference` por uma chamada à
 * API e mantenha o cookie como cache; o resto (proxy, layout, provider) não muda.
 */
import {
	isUiLocalePreference,
	UI_LOCALE_COOKIE_MAX_AGE,
	UI_LOCALE_PREF_COOKIE,
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

/** Linha `Set-Cookie` (sem HttpOnly: o cliente grava) da escolha. "auto" apaga a escolha; o idioma resolvido não é guardado (o layout o recalcula a cada requisição). */
export function localePreferenceCookies(preference: UiLocalePreference): string[] {
	const base = "; Path=/; SameSite=Lax";
	if (preference === "auto") return [`${UI_LOCALE_PREF_COOKIE}=; Max-Age=0${base}`];
	return [`${UI_LOCALE_PREF_COOKIE}=${preference}; Max-Age=${UI_LOCALE_COOKIE_MAX_AGE}${base}`];
}

/** Grava a escolha no navegador. O chamador recarrega os dados do servidor (`router.refresh()`). */
export function writeUiLocalePreference(preference: UiLocalePreference): void {
	if (typeof document === "undefined") return;
	for (const line of localePreferenceCookies(preference)) document.cookie = line;
}

export function readUiLocalePreference(): UiLocalePreference {
	if (typeof document === "undefined") return "auto";
	return parseLocalePreference(document.cookie);
}

/**
 * Escolha a gravar ao clicar em `target`, ou `null` se já é a escolha guardada. Compara com a escolha
 * (cookie), não com o idioma resolvido: com Accept-Language en-US e sem cookie, clicar em English fixa o idioma.
 */
export function nextLocalePreference(target: UiLocalePreference, stored: UiLocalePreference): UiLocalePreference | null {
	return target === stored ? null : target;
}
