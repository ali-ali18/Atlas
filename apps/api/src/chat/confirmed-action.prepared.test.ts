import assert from "node:assert/strict";
import { test } from "node:test";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";

const { prisma } = await import("@workspace/db");
const { maybeHandleConfirmedAction, PREPARED_DISMISSED_DETAIL } = await import("./confirmed-action.js");
const { runInheritanceFor } = await import("../routes/runs.js");

const USER = "user-a";
const CONV = "conv-1";
const CARD = "confirm-toolab12cd34-runR";

/**
 * Rascunho de `prepare_for_owner` (motor v3, PR8b): intenção `tool-call` com `prepared`, deixada por um run de rotina
 * (`runR`) sem pessoa. Banco em memória como no teste do cartão genérico.
 */
function fakeDb(owner = USER) {
	const state = { cleared: false, status: "pending", outcome: undefined as { ok: boolean; detail: string } | undefined, draftDecision: undefined as string | undefined };
	const originals = { find: prisma.skillPendingIntent.findUnique, del: prisma.skillPendingIntent.deleteMany, many: prisma.conversationMessage.findMany, update: prisma.conversationMessage.update };
	prisma.skillPendingIntent.findUnique = (async () => ({
		id: "p1", userId: owner, conversationId: CONV, kind: "confirm", expiresAt: new Date(Date.now() + 60_000),
		payload: { kind: "confirm", action: "tool-call", confirmId: CARD, toolCall: { callKey: "k-mail", tool: "email_send", label: "Enviar esta mensagem", prepared: true } },
	})) as unknown as typeof prisma.skillPendingIntent.findUnique;
	prisma.skillPendingIntent.deleteMany = (async () => { state.cleared = true; return { count: 1 }; }) as unknown as typeof prisma.skillPendingIntent.deleteMany;
	prisma.conversationMessage.findMany = (async () => [{ id: "m1", content: JSON.stringify({ v: 1, kind: "confirm", confirmId: CARD, title: "Enviar esta mensagem?", status: state.status, callKey: "k-mail", ...(state.outcome ? { outcome: state.outcome } : {}) }), createdAt: new Date() }]) as unknown as typeof prisma.conversationMessage.findMany;
	prisma.conversationMessage.update = (async (args: { data: { content: string } }) => {
		const next = JSON.parse(args.data.content) as { status: string; outcome?: { ok: boolean; detail: string }; draftDecision?: string };
		state.status = next.status;
		state.outcome = next.outcome;
		state.draftDecision = next.draftDecision;
		return {};
	}) as unknown as typeof prisma.conversationMessage.update;
	return { state, restore: () => { Object.assign(prisma.skillPendingIntent, { findUnique: originals.find, deleteMany: originals.del }); Object.assign(prisma.conversationMessage, { findMany: originals.many, update: originals.update }); } };
}

const run = (text: string, userId = USER) => maybeHandleConfirmedAction({ text, userId, botId: "bot-1", conversationId: CONV, model: "m", continueInAgent: true });
type FollowUp = { content: string; humanTyped?: true; inheritFromRunId?: string; transcript?: { fromRunId: string; toolName?: string; resultContent: string } };
const followUp = (result: unknown) => (result as { followUp?: FollowUp }).followUp;

test("Permitir no rascunho: a continuação chama a ação com os args do rascunho, semeada na chamada que preparou", async () => {
	const db = fakeDb();
	try {
		const result = await run("confirmado: Enviar esta mensagem?");
		const follow = followUp(result)!;
		assert.match(follow.content, /APPROVED your draft: Enviar esta mensagem/);
		assert.match(follow.content, /Call email_send now with EXACTLY the arguments of that draft/);
		assert.equal(follow.transcript?.fromRunId, "runR");
		assert.equal(follow.transcript?.toolName, "prepare_for_owner");
		// A continuação herda motor e perfil do run que preparou, nunca o turno humano de uma fala antiga da conversa.
		assert.equal(follow.inheritFromRunId, "runR");
		assert.deepEqual(runInheritanceFor({ origin: "chat" }, true, follow.inheritFromRunId), { inheritFromRunId: "runR", inheritHumanTurn: false });
		assert.equal(db.state.status, "approved");
		assert.deepEqual(db.state.outcome, { ok: true, detail: "aprovado pelo usuário" });
	} finally { db.restore(); }
});

test("Agora não no rascunho: descarta, sem run novo (duplicata) e sem nada para o modelo", async () => {
	const db = fakeDb();
	try {
		const result = await run("cancela isso");
		assert.deepEqual(result, { handled: false, duplicate: true });
		assert.equal(db.state.status, "rejected");
		assert.deepEqual(db.state.outcome, { ok: false, detail: PREPARED_DISMISSED_DETAIL });
		assert.equal(db.state.draftDecision, "dismissed");
		assert.equal(db.state.cleared, true);
	} finally { db.restore(); }
});

test("dono escreveu outra coisa com o rascunho pendente: Dispensado, e a fala segue como conversa comum (sem semente)", async () => {
	const db = fakeDb();
	try {
		const result = await run("me fala o clima de amanhã");
		assert.deepEqual(result, { handled: false });
		assert.deepEqual(db.state.outcome, { ok: false, detail: "Dispensado" });
		assert.equal(db.state.draftDecision, "ignored");
	} finally { db.restore(); }
});

test("usuário B não aprova nem descarta o rascunho do usuário A", async () => {
	const db = fakeDb("user-a");
	try {
		assert.equal(followUp(await run("confirmado: Enviar esta mensagem?", "user-b")), undefined);
		await run("cancela isso", "user-b");
		assert.equal(db.state.status, "pending");
	} finally { db.restore(); }
});

test("clique de cartão comum continua herdando da conversa; fala digitada não herda", () => {
	assert.deepEqual(runInheritanceFor({ origin: "chat" }, true, undefined), { inheritFromConversation: true });
	assert.deepEqual(runInheritanceFor({ origin: "chat" }, false, undefined), { inheritFromConversation: false });
});
