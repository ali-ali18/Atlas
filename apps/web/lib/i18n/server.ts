import { cookies, headers } from "next/headers";

import { resolveUiLocale, UI_LOCALE_PREF_COOKIE, isUiLocalePreference, type UiLocale } from "./locales";
import { loadMessages } from "./messages";
import { createTranslator, type MessageDictionary, type Translator } from "./translator";

/**
 * Idioma da requisição (componentes de servidor, layout, metadata).
 *
 * Ponto de extensão da conta: quando existir `uiLocale` guardado no servidor, leia-o aqui e passe como
 * `accountLocale`; ele vence o cookie, e o cookie vira só a escolha deste navegador.
 * Ler cookie/header torna a rota dinâmica: aceitável, o app inteiro fica atrás de login.
 */
export async function getUiLocale(): Promise<UiLocale> {
	const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
	const raw = cookieStore.get(UI_LOCALE_PREF_COOKIE)?.value;
	return resolveUiLocale({
		accountLocale: null,
		preference: isUiLocalePreference(raw) ? raw : null,
		acceptLanguage: headerStore.get("accept-language"),
	});
}

export async function getUiMessages(locale: UiLocale): Promise<MessageDictionary> {
	return loadMessages(locale);
}

/** Tradutor para componentes de servidor: `const { t } = await getTranslations()`. */
export async function getTranslations(): Promise<Translator> {
	const locale = await getUiLocale();
	return createTranslator(locale, await loadMessages(locale));
}
