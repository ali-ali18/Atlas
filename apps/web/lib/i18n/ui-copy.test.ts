import assert from "node:assert/strict"
import test from "node:test"
import { DEFAULT_UI_COPY } from "@workspace/ui/components/ui-copy"
import { UI_LOCALES } from "./locales"
import { loadMessages } from "./messages"
import { createTranslator } from "./translator"
import { uiCopyFrom } from "./ui-copy"

test("o pt-BR do app é idêntico ao padrão do packages/ui (não há duas verdades)", () => {
	assert.deepEqual(uiCopyFrom(createTranslator("pt-BR").t), DEFAULT_UI_COPY)
})

test("todo idioma preenche todos os textos do packages/ui", async () => {
	for (const locale of UI_LOCALES) {
		const copy = uiCopyFrom(createTranslator(locale, await loadMessages(locale)).t)
		assert.deepEqual(Object.keys(copy).sort(), Object.keys(DEFAULT_UI_COPY).sort())
		for (const [key, value] of Object.entries(copy)) assert.notEqual(value.trim(), "", `${locale}.${key}`)
	}
})
