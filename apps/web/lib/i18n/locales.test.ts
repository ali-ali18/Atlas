import assert from "node:assert/strict"
import test from "node:test"
import { matchUiLocale, parseAcceptLanguage, resolveUiLocale } from "./locales"

test("parseAcceptLanguage ordena por q e ignora curinga e q=0", () => {
	assert.deepEqual(parseAcceptLanguage("en;q=0.5, pt-BR, es;q=0.8, *;q=0.1, fr;q=0"), ["pt-BR", "es", "en"])
	assert.deepEqual(parseAcceptLanguage(""), [])
	assert.deepEqual(parseAcceptLanguage(null), [])
})

test("matchUiLocale casa a tag inteira e depois o idioma-base", () => {
	assert.equal(matchUiLocale(["EN-us"]), "en-US")
	assert.equal(matchUiLocale(["en-GB"]), "en-US")
	assert.equal(matchUiLocale(["pt-PT"]), "pt-BR")
	assert.equal(matchUiLocale(["es-MX", "en"]), "es-ES")
	assert.equal(matchUiLocale(["fr", "de"]), null)
	// Primeira tag suportada vence, mesmo que venha depois de uma não suportada.
	assert.equal(matchUiLocale(["fr", "en"]), "en-US")
})

test("resolveUiLocale: conta > cookie > Accept-Language > pt-BR", () => {
	assert.equal(resolveUiLocale({}), "pt-BR")
	assert.equal(resolveUiLocale({ acceptLanguage: "fr-FR" }), "pt-BR")
	assert.equal(resolveUiLocale({ acceptLanguage: "en-GB,en;q=0.9" }), "en-US")
	assert.equal(resolveUiLocale({ preference: "es-ES", acceptLanguage: "en-US" }), "es-ES")
	assert.equal(resolveUiLocale({ preference: "auto", acceptLanguage: "es" }), "es-ES")
	assert.equal(resolveUiLocale({ accountLocale: "en-US", preference: "es-ES", acceptLanguage: "pt-BR" }), "en-US")
})
