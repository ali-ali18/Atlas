import assert from "node:assert/strict"
import test from "node:test"
import { localePreferenceCookies, parseLocalePreference } from "./preference"

test("parseLocalePreference lê a escolha e trata ausente/inválido como auto", () => {
	assert.equal(parseLocalePreference("a=1; atlas-locale-pref=en-US; b=2"), "en-US")
	assert.equal(parseLocalePreference("atlas-locale-pref=fr-FR"), "auto")
	assert.equal(parseLocalePreference("atlas-locale=en-US"), "auto")
	assert.equal(parseLocalePreference(""), "auto")
})

test("parseLocalePreference: cookie com escape inválido vira auto (não lança)", () => {
	assert.equal(parseLocalePreference("atlas-locale-pref=%E0%A4%A"), "auto")
	assert.equal(parseLocalePreference("atlas-locale-pref=en%2DUS"), "en-US")
})

test("localePreferenceCookies: idioma fixo grava os dois cookies; auto apaga a escolha e segue o navegador", () => {
	const fixed = localePreferenceCookies("es-ES", ["en-US"])
	assert.match(fixed[0]!, /^atlas-locale-pref=es-ES; Max-Age=\d+/)
	assert.match(fixed[1]!, /^atlas-locale=es-ES;/)

	const auto = localePreferenceCookies("auto", ["fr-FR", "en-GB"])
	assert.match(auto[0]!, /^atlas-locale-pref=; Max-Age=0/)
	assert.match(auto[1]!, /^atlas-locale=en-US;/)
	assert.match(localePreferenceCookies("auto", [])[1]!, /^atlas-locale=pt-BR;/)
})
