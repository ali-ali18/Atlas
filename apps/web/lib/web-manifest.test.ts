import assert from "node:assert/strict"
import test from "node:test"

import { UI_LOCALES } from "@/lib/i18n/locales"
import { loadMessages } from "@/lib/i18n/messages"
import { webManifest } from "./web-manifest"

test("manifesto: descrição vem do idioma da interface; o resto não muda", async () => {
	const descriptions = new Set<string>()
	for (const locale of UI_LOCALES) {
		const manifest = webManifest((await loadMessages(locale))["app.manifestDescription"])
		descriptions.add(manifest.description ?? "")
		assert.equal(manifest.name, "Atlas")
		assert.equal(manifest.display, "standalone")
		assert.equal(manifest.icons?.length, 3)
	}
	assert.equal(descriptions.size, UI_LOCALES.length)
	assert.equal(webManifest("x").start_url, "/")
})
