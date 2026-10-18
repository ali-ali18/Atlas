import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConversationCard } from "@workspace/shared";
import { FakeTable, installFakes } from "./testing/fake-tables.js";
import { persistConversationCardFromEvent, markLoginCardDone } from "./conversations.js";
test("card de conexão persiste toolkit sem credenciais e conserva ao concluir", async () => {
 const messages = new FakeTable([], () => ({ createdAt: new Date() }));
 const installed = installFakes({ conversationMessage: messages, conversation: new FakeTable([{ id: "conversation-a" }]) });
 try {
  const event = { type: "login" as const, loginId: "login-a", site: "linear", url: "https://composio.dev", composioToolkit: "linear", status: "pending" as const };
  await persistConversationCardFromEvent("conversation-a", event);
  assert.equal(messages.rows.length, 1);
  const content = messages.rows[0]?.content;
  assert.equal(typeof content, "string");
  assert.deepEqual(parseConversationCard(String(content)), { v: 1, kind: "login", loginId: "login-a", site: "linear", url: "https://composio.dev", composioToolkit: "linear", status: "pending" });
  await markLoginCardDone("conversation-a", "login-a");
  const done = parseConversationCard(String(messages.rows[0]?.content));
  assert.equal(done?.kind, "login");
  if (done?.kind === "login") { assert.equal(done.composioToolkit, "linear"); assert.equal(done.status, "done"); }
 } finally { installed.restore(); }
});

test("card de conexão nativo persiste ícone, nome e descrição e conserva ao concluir", async () => {
	const messages = new FakeTable([], () => ({ createdAt: new Date() }));
	const installed = installFakes({ conversationMessage: messages, conversation: new FakeTable([{ id: "conversation-a" }]) });
	try {
		const connector = { kind: "native" as const, id: "github", name: "GitHub", description: "Repositórios", icon: "/connectors/github.svg" };
		await persistConversationCardFromEvent("conversation-a", { type: "login", loginId: "login-n", site: "GitHub", url: "https://github.com", status: "pending", connector });
		const card = parseConversationCard(String(messages.rows[0]?.content));
		assert.equal(card?.kind === "login" && card.connector?.name, "GitHub");
		await markLoginCardDone("conversation-a", "login-n");
		const done = parseConversationCard(String(messages.rows[0]?.content));
		assert.deepEqual(done?.kind === "login" ? done.connector : null, connector);
	} finally { installed.restore(); }
});

test("aviso de fallback não duplica no mesmo run (retomado), mas outro run grava novo card", async () => {
	const messages = new FakeTable([], () => ({ createdAt: new Date() }));
	const installed = installFakes({ conversationMessage: messages, conversation: new FakeTable([{ id: "conversation-a" }]) });
	try {
		const notice = { type: "provider_fallback" as const, from: "opencode-go/kimi-k3", to: "deepseek/x", reason: "opencode_go_unavailable", message: "usando x" };
		const runStartedAt = new Date(Date.now() - 1000);
		await persistConversationCardFromEvent("conversation-a", notice, { runStartedAt });
		await persistConversationCardFromEvent("conversation-a", notice, { runStartedAt });
		assert.equal(messages.rows.length, 1);
		await persistConversationCardFromEvent("conversation-a", notice, { runStartedAt: new Date(Date.now() + 5000) });
		assert.equal(messages.rows.length, 2);
	} finally { installed.restore(); }
});
