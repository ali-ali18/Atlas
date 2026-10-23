import assert from "node:assert/strict"
import test from "node:test"
import { isPublicWebPath, isSharedPagePath } from "./public-paths"

const TOKEN = "A".repeat(43)

test("só /login e /p/<token> de 43 caracteres abrem sem sessão", () => {
	assert.equal(isPublicWebPath("/login"), true)
	assert.equal(isPublicWebPath(`/p/${TOKEN}`), true)
	assert.equal(isSharedPagePath(`/p/${TOKEN}/`), true)
})

test("nenhum outro caminho escapa do login", () => {
	for (const path of ["/", "/p", "/p/", "/p/x", `/p/${TOKEN}/extra`, `/p/${TOKEN}x`, `/p/../${TOKEN}`, "/p/%2e%2e", `/pp/${TOKEN}`, "/chat", "/login/x"]) {
		assert.equal(isPublicWebPath(path), false, path)
	}
})
