import assert from "node:assert/strict";
import { test } from "node:test";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";

const { prisma } = await import("@workspace/db");
const { maybeHandleConfirmedAction, askingRunId, seedField, toolCallFollowUpContent } = await import("./confirmed-action.js");

const USER = "user-a";
const CONV = "conv-1";

/** Intenção pendente `tool-call` (cartão genérico do motor v3) e o cartão, em memória. */
function fakeDb(owner = USER) {
	const state = { cleared: false, status: "pending", outcome: undefined as { ok: boolean; detail: string } | undefined };
	const originals = { find: prisma.skillPendingIntent.findUnique, del: prisma.skillPendingIntent.deleteMany, many: prisma.conversationMessage.findMany, update: prisma.conversationMessage.update };
	prisma.skillPendingIntent.findUnique = (async () => ({
		id: "p1", userId: owner, conversationId: CONV, kind: "confirm", expiresAt: new Date(Date.now() + 60_000),
		payload: { kind: "confirm", action: "tool-call", confirmId: "confirm-toolab12cd34-run9", toolCall: { callKey: "k-share", tool: "page_share", label: "Criar um link público do painel" } },
	})) as unknown as typeof prisma.skillPendingIntent.findUnique;
	prisma.skillPendingIntent.deleteMany = (async () => { state.cleared = true; return { count: 1 }; }) as unknown as typeof prisma.skillPendingIntent.deleteMany;
	prisma.conversationMessage.findMany = (async () => [{ id: "m1", content: JSON.stringify({ v: 1, kind: "confirm", confirmId: "confirm-toolab12cd34-run9", title: "Criar um link público do painel?", status: state.status, callKey: "k-share", ...(state.outcome ? { outcome: state.outcome } : {}) }), createdAt: new Date() }]) as unknown as typeof prisma.conversationMessage.findMany;
	prisma.conversationMessage.update = (async (args: { data: { content: string } }) => {
		const next = JSON.parse(args.data.content) as { status: string; outcome?: { ok: boolean; detail: string } };
		state.status = next.status;
		state.outcome = next.outcome;
		return {};
	}) as unknown as typeof prisma.conversationMessage.update;
	return { state, restore: () => { Object.assign(prisma.skillPendingIntent, { findUnique: originals.find, deleteMany: originals.del }); Object.assign(prisma.conversationMessage, { findMany: originals.many, update: originals.update }); } };
}

const run = (text: string, userId = USER) => maybeHandleConfirmedAction({ text, userId, botId: "bot-1", conversationId: CONV, model: "m", continueInAgent: true });
const followUp = (result: unknown) => (result as { followUp: { content: string; transcript?: { fromRunId: string; toolName?: string } } }).followUp;

test("aprovar: cartão aprovado com resultado ok; o agente repete a MESMA chamada e o desfecho vira o resultado da chamada que parou", async () => {
	const db = fakeDb();
	try {
		const result = await run("confirmado: Criar um link público do painel?");
		assert.equal(result.handled, false);
		assert.match(followUp(result).content, /APPROVED: Criar um link público do painel/);
		assert.match(followUp(result).content, /Call page_share again with EXACTLY the same arguments/);
		assert.equal(followUp(result).transcript?.fromRunId, "run9");
		assert.equal(followUp(result).transcript?.toolName, "page_share");
		assert.equal(db.state.status, "approved");
		assert.deepEqual(db.state.outcome, { ok: true, detail: "aprovado pelo usuário" });
	} finally { db.restore(); }
});

test("recusar: cartão recusado com resultado ok:false e o agente sabe que nada foi feito", async () => {
	const db = fakeDb();
	try {
		const result = await run("cancela isso");
		assert.match(followUp(result).content, /did NOT approve/);
		assert.equal(db.state.status, "rejected");
		assert.equal(db.state.outcome?.ok, false);
	} finally { db.restore(); }
});

test("usuário B não aprova a chamada do usuário A", async () => {
	const db = fakeDb("user-a");
	try {
		const result = await run("confirmado: Criar um link público do painel?", "user-b");
		assert.equal((result as { followUp?: unknown }).followUp, undefined);
		assert.equal(db.state.status, "pending");
	} finally { db.restore(); }
});

test("o id do cartão genérico devolve o run que pediu", () => {
	assert.equal(askingRunId("confirm-toolab12cd34-run9"), "run9");
	assert.equal(seedField({ confirmId: "confirm-toolab12cd34-run9" }, "page_share", toolCallFollowUpContent("", { tool: "page_share", label: "x" }, "approved"), "ok").transcript?.toolName, "page_share");
});
