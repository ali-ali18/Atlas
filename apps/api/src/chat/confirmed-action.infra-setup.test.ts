import assert from "node:assert/strict";
import { test } from "node:test";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";

const { prisma } = await import("@workspace/db");
const { maybeHandleConfirmedAction } = await import("./confirmed-action.js");

const USER = "user-a";
const CONV = "conv-1";

/** Intenção pendente `infra-setup` e o cartão, em memória. */
function fakeDb(owner = USER) {
	const state = { cleared: false, status: "pending", outcome: undefined as { ok: boolean; detail: string } | undefined };
	const originals = { find: prisma.skillPendingIntent.findUnique, del: prisma.skillPendingIntent.deleteMany, many: prisma.conversationMessage.findMany, update: prisma.conversationMessage.update };
	prisma.skillPendingIntent.findUnique = (async () => ({
		id: "p1", userId: owner, conversationId: CONV, kind: "confirm", expiresAt: new Date(Date.now() + 60_000),
		payload: { kind: "confirm", action: "infra-setup", confirmId: "confirm-r1", infraSetup: { callKey: "k-dns", label: "criar o endereço curinga das prévias" } },
	})) as unknown as typeof prisma.skillPendingIntent.findUnique;
	prisma.skillPendingIntent.deleteMany = (async () => { state.cleared = true; return { count: 1 }; }) as unknown as typeof prisma.skillPendingIntent.deleteMany;
	prisma.conversationMessage.findMany = (async () => [{ id: "m1", content: JSON.stringify({ v: 1, kind: "confirm", confirmId: "confirm-r1", title: "Criar?", status: state.status, callKey: "k-dns", ...(state.outcome ? { outcome: state.outcome } : {}) }), createdAt: new Date() }]) as unknown as typeof prisma.conversationMessage.findMany;
	prisma.conversationMessage.update = (async (args: { data: { content: string } }) => {
		const next = JSON.parse(args.data.content) as { status: string; outcome?: { ok: boolean; detail: string } };
		state.status = next.status;
		state.outcome = next.outcome;
		return {};
	}) as unknown as typeof prisma.conversationMessage.update;
	return { state, restore: () => { Object.assign(prisma.skillPendingIntent, { findUnique: originals.find, deleteMany: originals.del }); Object.assign(prisma.conversationMessage, { findMany: originals.many, update: originals.update }); } };
}

const run = (text: string, userId = USER) => maybeHandleConfirmedAction({ text, userId, botId: "bot-1", conversationId: CONV, model: "m", continueInAgent: true });

test("aprovar: cartão aprovado com resultado ok e o agente é mandado repetir preview_setup", async () => {
	const db = fakeDb();
	try {
		const result = await run("confirmado: Criar o endereço curinga das prévias?");
		assert.equal(result.handled, false);
		assert.match((result as { followUp: { content: string } }).followUp.content, /APROVOU: criar o endereço curinga/);
		assert.match((result as { followUp: { content: string } }).followUp.content, /preview_setup de novo/);
		assert.equal(db.state.status, "approved");
		assert.equal(db.state.outcome?.ok, true);
	} finally { db.restore(); }
});

test("recusar: nada é aprovado e o agente é avisado de que nada mudou", async () => {
	const db = fakeDb();
	try {
		const result = await run("cancela isso");
		assert.equal(result.handled, false);
		assert.match((result as { followUp: { content: string } }).followUp.content, /NÃO aprovou/);
		assert.equal(db.state.status, "rejected");
		assert.equal(db.state.outcome?.ok, false);
	} finally { db.restore(); }
});

test("usuário B não aprova a intenção do usuário A", async () => {
	const db = fakeDb("user-a");
	try {
		const result = await run("confirmado: Criar o endereço curinga das prévias?", "user-b");
		assert.equal(result.handled, false);
		assert.equal((result as { followUp?: unknown }).followUp, undefined);
		assert.equal(db.state.status, "pending");
	} finally { db.restore(); }
});
