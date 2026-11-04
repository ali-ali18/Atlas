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

const seedOf = (result: unknown) => (result as { followUp?: { humanTyped?: true; content: string; transcript?: { resultContent: string; refused?: string[]; shortContent: string } } }).followUp;

test("dono ignorou o cartão e escreveu outra coisa: Dispensado, sem Jev/regex, e o modelo recebe a fala nova como resultado", async () => {
	const db = fakeDb();
	try {
		// "sim" digitado não aprova o cartão genérico do v3: só o botão aprova.
		const result = await maybeHandleConfirmedAction({ text: "sim, mas antes me manda o resumo", userId: USER, botId: "bot-1", conversationId: CONV, model: "m", continueInAgent: true, jevIntent: async () => ({ cancel: false, confirm: true }) });
		const follow = seedOf(result)!;
		assert.equal(follow.humanTyped, true);
		assert.equal(follow.content, "sim, mas antes me manda o resumo");
		assert.match(follow.transcript!.resultContent, /did not answer the previous request \("Criar um link público do painel"\) and sent: "sim, mas antes me manda o resumo"/);
		assert.deepEqual(follow.transcript!.refused, ["call:k-share"]);
		assert.equal(follow.transcript!.shortContent, "sim, mas antes me manda o resumo");
		assert.equal(db.state.status, "rejected");
		assert.deepEqual(db.state.outcome, { ok: false, detail: "Dispensado" });
		assert.equal(db.state.cleared, true);
	} finally { db.restore(); }
});

test("recusar leva a chave recusada para a continuação (não pede de novo) e diz para seguir com o resto", async () => {
	const db = fakeDb();
	try {
		const follow = seedOf(await run("cancela isso"))!;
		assert.deepEqual(follow.transcript!.refused, ["call:k-share"]);
		assert.match(follow.transcript!.resultContent, /Continue the rest of the task without it/);
	} finally { db.restore(); }
});

test("aprovar não marca a chave como recusada", async () => {
	const db = fakeDb();
	try {
		const follow = seedOf(await run("confirmado: Criar um link público do painel?"))!;
		assert.equal(follow.transcript!.refused, undefined);
	} finally { db.restore(); }
});
