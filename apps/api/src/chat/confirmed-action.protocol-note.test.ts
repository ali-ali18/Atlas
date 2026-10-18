import assert from "node:assert/strict";
import { test } from "node:test";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";

const { applyConfirmedFollowUp, devCommandFollowUpContent } = await import("./confirmed-action.js");
const { CARD_PROTOCOL_NOTE } = await import("@workspace/shared");

test("o que o modelo recebe depois do clique avisa que é protocolo e não deve ser narrado", () => {
	const content = devCommandFollowUpContent("confirmado: Executar este comando?", { tool: "shell", label: "pnpm test" }, { kind: "approved" });
	const messages = applyConfirmedFollowUp([{ role: "user", content: "confirmado: Executar este comando?" }], { objective: "confirmado: Executar este comando?", content });
	assert.ok(messages[0]!.content.startsWith("confirmado:"), "a primeira linha continua sendo o token (a UI esconde o balão por ela)");
	assert.ok(messages[0]!.content.includes(CARD_PROTOCOL_NOTE));
});
