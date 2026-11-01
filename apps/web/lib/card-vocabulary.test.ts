// Vocabulário único dos cards do chat (ver packages/ui/src/lib/chat-card-copy.ts):
// os rótulos antigos não podem voltar nos arquivos dos cards.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));

const CARD_FILES = [
	"packages/ui/src/components/confirm-alert.tsx",
	"packages/ui/src/components/plan-card.tsx",
	"apps/web/components/ai-elements/bot-messages/bot-needs-user-card.tsx",
	"apps/web/components/ai-elements/dev-session/dev-approval-card.tsx",
	"apps/web/components/ai-elements/dev-session/secrets-request-card.tsx",
	"apps/web/components/ai-elements/dev-session/vault-request-card.tsx",
	"apps/web/components/ai-elements/email/email-key-request-card.tsx",
	"apps/web/components/ai-elements/skills/skill-proposal-card.tsx",
	"apps/web/components/ai-elements/bots/bot-proposal-card.tsx",
	"apps/web/components/ai-elements/budget-continue/budget-continue-card.tsx",
	"apps/web/components/ai-elements/login/api-connect-card.tsx",
	"apps/web/components/ai-elements/login/connector-login-card.tsx",
	"apps/web/components/ai-elements/login/login-card.tsx",
];

const BANNED = [/label: "Pulado"/, /label: "Aguardando você"/, /label: "Aguardando seu OK"/, /label: "Precisa de aprovação"/, /cancelLabel = "Pular"/];

test("cards do chat não usam os rótulos antigos de pendente, dispensado e dispensar", () => {
	for (const file of CARD_FILES) {
		const src = readFileSync(join(REPO, file), "utf8");
		for (const banned of BANNED) assert.doesNotMatch(src, banned, `${file}: ${banned}`);
	}
});

test("botão secundário dos cards é sempre 'secondary' e nunca xs", () => {
	for (const file of CARD_FILES) {
		const src = readFileSync(join(REPO, file), "utf8");
		assert.doesNotMatch(src, /<Button[^>]*variant="outline"/, `${file}: outline`);
		assert.doesNotMatch(src, /<Button[^>]*size="xs"/, `${file}: size xs`);
	}
});
