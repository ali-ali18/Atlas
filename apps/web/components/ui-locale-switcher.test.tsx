import assert from "node:assert/strict"
import test from "node:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { UI_LOCALES } from "@/lib/i18n/locales"
import { loadMessages } from "@/lib/i18n/messages"
import { I18nProvider } from "@/lib/i18n/provider"
import { UiLocaleSwitcher } from "./ui-locale-switcher"

Object.assign(globalThis, { React })

test("o seletor da tela de login lista os idiomas pelo nome deles e marca o atual", async () => {
	const html = renderToStaticMarkup(
		<I18nProvider locale="en-US" messages={await loadMessages("en-US")}>
			<UiLocaleSwitcher />
		</I18nProvider>,
	)
	assert.match(html, /aria-label="Language"/)
	for (const label of ["Português", "English", "Español"]) assert.ok(html.includes(`>${label}<`), label)
	assert.match(html, /aria-current="true"[^>]*lang="en-US"|lang="en-US"[^>]*aria-current="true"|aria-current="true"[^>]*>English</)
	assert.equal((html.match(/aria-current/g) ?? []).length, 1)
})

test("a frase da marca tem um único destaque <em> em todos os idiomas", async () => {
	for (const locale of UI_LOCALES) {
		const quote = (await loadMessages(locale))["login.quote"]
		assert.equal((quote.match(/<em>[^<]+<\/em>/g) ?? []).length, 1, locale)
		assert.equal(quote.replace(/<\/?em>/g, "").includes("<"), false, locale)
	}
})
