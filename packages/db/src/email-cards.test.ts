/** Cartões de e-mail (F7.1) gravados na conversa: um por `cardId` (retomada e evento ao vivo não duplicam) e revalidados. */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { parseConversationCard } from "@workspace/shared";
import { prisma } from "./client.js";
import { FakeTable, installFakes } from "./testing/fake-tables.js";
import { persistConversationCardFromEvent } from "./conversations.js";

let messages: InstanceType<typeof FakeTable>;
let installed: { restore: () => void };
let originalConversation: unknown;

beforeEach(() => {
	messages = new FakeTable([], () => ({ createdAt: new Date() }));
	installed = installFakes({ conversationMessage: messages });
	const client = prisma as unknown as Record<string, unknown>;
	originalConversation = client.conversation;
	client.conversation = { findUnique: async () => ({ id: "conv-1" }) };
});
afterEach(() => {
	installed.restore();
	(prisma as unknown as Record<string, unknown>).conversation = originalConversation;
});

const rows = async () => (await messages.findMany({})) as Array<{ role: string; content: string }>;

const triage = { type: "email_triage" as const, cardId: "run-1:email-triage:aa", runId: "run-1", items: [{ id: "m1", category: "needs_action" as const, summary: "Aprovar o orçamento", deadline: "2026-11-12" }] };
const draft = { type: "email_draft" as const, cardId: "run-1:email-draft:bb", runId: "run-1", source: "gmail" as const, to: ["ana@empresa.test"], subject: "Re: Orçamento", body: "Aprovado.", reply: true, saved: true };

test("triagem e rascunho: papel próprio, sem o campo type, e o mesmo cardId não duplica", async () => {
	for (const event of [triage, triage, draft, draft]) await persistConversationCardFromEvent("conv-1", event);
	const saved = await rows();
	assert.deepEqual(saved.map((r) => r.role).sort(), ["email-draft", "email-triage"]);
	for (const row of saved) assert.equal(row.content.includes('"type"'), false);
	assert.equal(parseConversationCard(saved.find((r) => r.role === "email-triage")!.content)?.kind, "email-triage");
});

test("outro cardId é outro cartão (rascunho novo no mesmo run)", async () => {
	await persistConversationCardFromEvent("conv-1", draft);
	await persistConversationCardFromEvent("conv-1", { ...draft, cardId: "run-1:email-draft:cc", body: "Aprovado, com ressalvas." });
	assert.equal((await rows()).length, 2);
});

test("cartão inválido não grava: categoria fora do enum, destinatário com quebra de linha, corpo vazio", async () => {
	await persistConversationCardFromEvent("conv-1", { ...triage, items: [{ id: "m1", category: "urgent", summary: "x" }] } as never);
	await persistConversationCardFromEvent("conv-1", { ...draft, to: ["a@b.test\nBcc: x@y.test"] });
	await persistConversationCardFromEvent("conv-1", { ...draft, body: "   " });
	assert.equal((await rows()).length, 0);
});
