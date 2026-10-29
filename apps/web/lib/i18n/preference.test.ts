import assert from "node:assert/strict"
import test from "node:test"
import { localePreferenceCookies, nextLocalePreference, parseLocalePreference } from "./preference"

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

test("localePreferenceCookies: idioma fixo grava só a escolha; auto a apaga (sem cookie de idioma resolvido)", () => {
	const fixed = localePreferenceCookies("es-ES")
	assert.equal(fixed.length, 1)
	assert.match(fixed[0]!, /^atlas-locale-pref=es-ES; Max-Age=\d+/)

	const auto = localePreferenceCookies("auto")
	assert.deepEqual(auto, ["atlas-locale-pref=; Max-Age=0; Path=/; SameSite=Lax"])
})

test("nextLocalePreference compara com a escolha guardada, não com o idioma resolvido", () => {
	// Accept-Language en-US sem cookie: a escolha guardada é "auto"; clicar em English deve fixar.
	assert.equal(nextLocalePreference("en-US", "auto"), "en-US")
	assert.equal(nextLocalePreference("en-US", "en-US"), null)
	assert.equal(nextLocalePreference("auto", "en-US"), "auto")
	assert.equal(nextLocalePreference("auto", "auto"), null)
})
