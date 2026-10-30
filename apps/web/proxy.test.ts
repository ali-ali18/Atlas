import assert from "node:assert/strict"
import test from "node:test"
import { NextRequest } from "next/server"
import { proxy } from "./proxy"

const request = (path: string, headers: Record<string, string> = {}) =>
	new NextRequest(`http://localhost:3000${path}`, { headers })

test("o idioma da interface é resolvido no layout: o proxy não grava cookie de idioma", () => {
	const redirect = proxy(request("/", { "accept-language": "en-GB,en;q=0.8" }))
	assert.equal(redirect.status, 307)
	assert.equal(redirect.cookies.get("atlas-locale"), undefined)

	const login = proxy(request("/login", { "accept-language": "es-MX" }))
	assert.equal(login.status, 200)
	assert.equal(login.cookies.get("atlas-locale"), undefined)
})

test("sem sessão vai ao login; rota pública passa", () => {
	assert.equal(proxy(request("/")).headers.get("location"), "http://localhost:3000/login")
	assert.equal(proxy(request("/login")).headers.get("location"), null)
})
