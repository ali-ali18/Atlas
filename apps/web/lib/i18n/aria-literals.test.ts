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

test("textos fixos em pt-BR que as prévias pegaram não voltam", () => {
	const banned: Record<string, RegExp[]> = {
		"components/ui/templates/template-4/mobile-chat-list.tsx": [/Explorar agentes/],
		"components/ui/templates/template-4/chat-thread/questionnaire-card.tsx": [/>\s*Enviar\s*</],
		"components/ui/templates/template-4/chat-thread/task-list-card.tsx": [/aria-label="(Concluído|Pendente)"/, /seeAllLabel/],
		"components/ui/templates/template-4/chat-thread/task-list-dock.tsx": [/aria-label="Tarefas do bot"/, /"Recolher a lista/],
	}
	for (const [file, patterns] of Object.entries(banned)) {
		const source = readFileSync(join(process.cwd(), file), "utf8")
		for (const pattern of patterns) assert.doesNotMatch(source, pattern, `${file}: ${pattern}`)
	}
})

test("campos de hora têm largura para 12 h (08:00 AM) sem cortar", () => {
	for (const file of [
		"components/settings/sections/work-hours.tsx",
		"components/settings/sections/reflection.tsx",
		"components/ui/templates/template-4/chat-context-panel/proactive-settings.tsx",
	]) {
		const source = readFileSync(join(process.cwd(), file), "utf8")
		assert.doesNotMatch(source, /w-\[7rem\]/, file)
	}
})

test("hooks e lib não escrevem mensagem de erro/estado em pt-BR direto (vem de activeT/Translator)", () => {
	const banned: Record<string, RegExp[]> = {
		"hooks/use-composio.ts": [/"Não foi possível/],
		"hooks/use-push-notifications.ts": [/"Não foi possível/, /"Notificações ativadas/, /"Permissão negada/],
		"hooks/use-image-attachments.ts": [/"Até 4 imagens/, /"Use PNG/],
		"hooks/use-file-attachments.ts": [/arquivos por mensagem/, /está vazio/],
		"hooks/use-atlas-chat.ts": [/"A execução foi cancelada/, /"O worker parou/, /Muitas reconexões/, /"Fila indisponível/],
		"lib/atlas-api.ts": [/"Sem conexão com o servidor/, /COMPACT_FAILED_TEXT/],
		"lib/jev-status.ts": [/"JEV (pediu|aprovou|observou)/],
		"lib/push-client.ts": [/"Receba um aviso/, /`há /],
		"lib/group-thread.ts": [/está digitando/, /Escolhendo quem responde/],
		"lib/routine-proposal-message.ts": [/"Agora não"/, /"Sugestão"/],
		"lib/dev-session/live-line.ts": [/return "Lendo arquivos"|: "Lendo arquivos"/, /"Buscando no código"/],
		"lib/dev-session/reducer.ts": [/IDLE: "Concluída"/, /CREATING: "Preparando"/],
		"lib/connector-accounts.ts": [/ANOTHER_ACCOUNT_HINT/, /`\$\{count\} contas`/],
	}
	for (const [file, patterns] of Object.entries(banned)) {
		const source = readFileSync(join(process.cwd(), file), "utf8")
		for (const pattern of patterns) assert.doesNotMatch(source, pattern, `${file}: ${pattern}`)
	}
})
