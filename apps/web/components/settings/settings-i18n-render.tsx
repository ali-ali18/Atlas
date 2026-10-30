import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { UiLocale } from "@/lib/i18n/locales";
import { loadMessages } from "@/lib/i18n/messages";
import { I18nProvider } from "@/lib/i18n/provider";

/** Renderiza uma tela das configurações em outro idioma (só para teste). */
export async function renderIn(locale: UiLocale, node: React.ReactNode): Promise<string> {
	return renderToStaticMarkup(
		<I18nProvider locale={locale} messages={await loadMessages(locale)}>
			{node}
		</I18nProvider>,
	);
}
