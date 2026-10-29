import assert from "node:assert/strict"
import test from "node:test"
import { NextRequest } from "next/server"
import { proxy } from "./proxy"

const request = (path: string, headers: Record<string, string> = {}) =>
	new NextRequest(`http://localhost:3000${path}`, { headers })

test("primeira visita grava atlas-locale a partir do Accept-Language, inclusive no redirect ao login", () => {
	const redirect = proxy(request("/", { "accept-language": "en-GB,en;q=0.8" }))
	assert.equal(redirect.status, 307)
	assert.equal(redirect.cookies.get("atlas-locale")?.value, "en-US")

	const login = proxy(request("/login", { "accept-language": "es-MX" }))
	assert.equal(login.cookies.get("atlas-locale")?.value, "es-ES")
})

test("a escolha do usuário vence o Accept-Language; sem nada suportado cai em pt-BR", () => {
	const chosen = proxy(request("/login", { "accept-language": "en-US", cookie: "atlas-locale-pref=es-ES" }))
	assert.equal(chosen.cookies.get("atlas-locale")?.value, "es-ES")
	assert.equal(proxy(request("/login", { "accept-language": "fr-FR" })).cookies.get("atlas-locale")?.value, "pt-BR")
})

test("cookie já correto não é regravado", () => {
	const same = proxy(request("/login", { "accept-language": "en-US", cookie: "atlas-locale=en-US" }))
	assert.equal(same.cookies.get("atlas-locale"), undefined)
})
