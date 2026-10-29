import { cookies, headers } from "next/headers";

import { resolveUiLocale, UI_LOCALE_PREF_COOKIE, isUiLocalePreference, type UiLocale, type UiLocalePreference } from "./locales";
import { loadMessages } from "./messages";
import { createTranslator, type MessageDictionary, type Translator } from "./translator";

/**
 * Idioma da requisição (componentes de servidor, layout, metadata) e a escolha do usuário que o originou.
 *
 * Ponto de extensão da conta: quando existir `uiLocale` guardado no servidor, leia-o aqui e passe como
 * `accountLocale`; ele vence o cookie, e o cookie vira só a escolha deste navegador.
 * Ler cookie/header torna a rota dinâmica: aceitável, o app inteiro fica atrás de login.
 */
export async function getUiLocaleState(): Promise<{ locale: UiLocale; preference: UiLocalePreference }> {
	const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
	const raw = cookieStore.get(UI_LOCALE_PREF_COOKIE)?.value;
	const preference = isUiLocalePreference(raw) ? raw : "auto";
	const locale = resolveUiLocale({
		accountLocale: null,
		preference,
		acceptLanguage: headerStore.get("accept-language"),
	});
	return { locale, preference };
}

export async function getUiLocale(): Promise<UiLocale> {
	return (await getUiLocaleState()).locale;
}

export async function getUiMessages(locale: UiLocale): Promise<MessageDictionary> {
	return loadMessages(locale);
}

/** Tradutor para componentes de servidor: `const { t } = await getTranslations()`. */
export async function getTranslations(): Promise<Translator> {
	const locale = await getUiLocale();
	return createTranslator(locale, await loadMessages(locale));
}
