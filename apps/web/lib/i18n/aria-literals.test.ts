import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"

/** Telas já traduzidas: nenhum aria-label com texto fixo (tem de vir de `t(...)`). */
const FILES = [
	"components/ai-elements/pages/page-card.tsx",
	"components/ai-elements/pages/page-dialog.tsx",
	"components/ai-elements/bot-messages/bot-exchange-view.tsx",
	"components/ui/templates/template-4/chat-thread/chat-thread.tsx",
	"components/ui/templates/template-4/chat-thread/questionnaire-card.tsx",
]

test("aria-label das telas traduzidas não tem texto fixo em pt-BR", () => {
	for (const file of FILES) {
		const source = readFileSync(join(process.cwd(), file), "utf8")
		const literals = [...source.matchAll(/aria-label=(?:"([^"]+)"|\{"([^"]+)"\}|\{[^}]*\?\s*"([^"]+)"\s*:)/g)].map((match) => match[1] ?? match[2] ?? match[3])
		assert.deepEqual(literals, [], `${file} tem aria-label fixo`)
	}
})
