"use client";

import * as React from "react";

import { UiCopyProvider } from "@workspace/ui/components/ui-copy";

import type { UiLocale, UiLocalePreference } from "./locales";
import { setActiveTranslator } from "./active";
import { uiCopyFrom } from "./ui-copy";
import { createTranslator, defaultTranslator, type MessageDictionary, type Translator } from "./translator";

type I18nContextValue = Translator & { preference: UiLocalePreference };

const I18nContext = React.createContext<I18nContextValue>({ ...defaultTranslator, preference: "auto" });

/**
 * Entrega `t`/`tn`/`locale` à árvore. O servidor (layout) resolve o idioma e passa só o dicionário
 * dele; no pt-BR `messages` é omitido porque o pt-BR já vai no bundle como fallback.
 * Sem provider (testes), o contexto é o tradutor pt-BR.
 */
export function I18nProvider({
	locale,
	messages = null,
	preference = "auto",
	children,
}: {
	locale: UiLocale;
	messages?: MessageDictionary | null;
	/** Escolha do usuário ("auto" = segue o navegador); o seletor das configurações lê daqui. */
	preference?: UiLocalePreference;
	children: React.ReactNode;
}) {
	const value = React.useMemo(() => ({ ...createTranslator(locale, messages), preference }), [locale, messages, preference]);
	// Código fora de componente (erros de hooks e da API) lê o tradutor daqui; ver `active.ts`.
	setActiveTranslator(value);
	// Os componentes de packages/ui recebem os textos pelo UiCopyProvider (o pacote não importa o app).
	const uiCopy = React.useMemo(() => uiCopyFrom(value.t), [value.t]);
	return (
		<I18nContext.Provider value={value}>
			<UiCopyProvider copy={uiCopy}>{children}</UiCopyProvider>
		</I18nContext.Provider>
	);
}

/** `{ t, tn, locale }` do idioma da tela. */
export function useTranslations(): Translator {
	return React.useContext(I18nContext);
}

/** Atalho: só a função `t`. */
export function useT(): Translator["t"] {
	return React.useContext(I18nContext).t;
}

/** Idioma da tela (para `format.ts` e `Intl`). */
export function useLocale(): UiLocale {
	return React.useContext(I18nContext).locale;
}

/** Escolha de idioma do usuário ("auto" ou um idioma fixo), vinda do servidor na renderização. */
export function useUiLocalePreference(): UiLocalePreference {
	return React.useContext(I18nContext).preference;
}
