import assert from "node:assert/strict";
import { test } from "node:test";
import { serializeConversationCard } from "@workspace/shared";
import { prisma } from "./client.js";
import { TOOL_CALL_CONSUMED_DETAIL, TOOL_CALL_DECLINE_USED_DETAIL, takeToolCallApproval, toolCardAskingRunId } from "./conversations.js";

type Row = { id: string; conversationId: string; content: string; createdAt: Date; ownerId: string };

/** Cartões em memória; os filtros de conversa e de dono do `findMany` são aplicados aqui como no banco. */
function fake(rows: Row[]) {
	const original = { findMany: prisma.conversationMessage.findMany, updateMany: prisma.conversationMessage.updateMany };
	prisma.conversationMessage.findMany = (async (args: { where: { conversationId: string; conversation?: { userId?: string } } }) =>
		rows
			.filter((row) => row.conversationId === args.where.conversationId && (!args.where.conversation?.userId || row.ownerId === args.where.conversation.userId))
			.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())) as unknown as typeof prisma.conversationMessage.findMany;
	prisma.conversationMessage.updateMany = (async (args: { where: { id: string; content: string }; data: { content: string } }) => {
		const row = rows.find((item) => item.id === args.where.id && item.content === args.where.content);
		if (!row) return { count: 0 };
		row.content = args.data.content;
		return { count: 1 };
	}) as unknown as typeof prisma.conversationMessage.updateMany;
	return () => Object.assign(prisma.conversationMessage, original);
}
const card = (status: "pending" | "approved" | "rejected", outcome?: { ok: boolean; detail: string }, askingRun = "run1", callKey = "k1") =>
	serializeConversationCard({ v: 1, kind: "confirm", confirmId: `confirm-toolabcd1234-${askingRun}`, title: "Criar um link público do painel?", status, callKey, ...(outcome ? { outcome } : {}) } as Parameters<typeof serializeConversationCard>[0]);
const row = (content: string, extra: Partial<Row> = {}): Row => ({ id: "m1", conversationId: "conv", content, createdAt: new Date(), ownerId: "user-a", ...extra });
const APPROVED = { ok: true, detail: "aprovado pelo usuário" };
const DECLINED = { ok: false, detail: "não aprovado pelo usuário" };

test("id do cartão genérico devolve o run que perguntou", () => {
	assert.equal(toolCardAskingRunId("confirm-toolabcd1234-cmrun9"), "cmrun9");
	assert.equal(toolCardAskingRunId("confirm-cmrun9"), undefined);
	assert.equal(toolCardAskingRunId("confirm-toolabcd1234-local"), undefined);
});

test("aprovação vale para UMA execução, só no run de continuação daquele cartão", async () => {
	const rows = [row(card("approved", APPROVED))];
	const restore = fake(rows);
	try {
		assert.equal(await takeToolCallApproval("user-a", "conv", "k1", undefined), null);
		assert.equal(await takeToolCallApproval("user-a", "conv", "k1", "outro-run"), null);
		assert.equal(await takeToolCallApproval("user-a", "conv", "k1", "run1"), "approved");
		assert.match(rows[0]!.content, new RegExp(TOOL_CALL_CONSUMED_DETAIL));
		assert.equal(await takeToolCallApproval("user-a", "conv", "k1", "run1"), null);
	} finally {
		restore();
	}
});

test("recusa é consumida como a aprovação: vale uma vez, depois o pedido mostra cartão novo", async () => {
	const rows = [row(card("rejected", DECLINED))];
	const restore = fake(rows);
	try {
		assert.equal(await takeToolCallApproval("user-a", "conv", "k1", "run1"), "declined");
		assert.match(rows[0]!.content, new RegExp(TOOL_CALL_DECLINE_USED_DETAIL));
		assert.equal(await takeToolCallApproval("user-a", "conv", "k1", "run1"), null);
	} finally {
		restore();
	}
});

test("filtros: outra conversa, outro dono, outra chamada, pendente, substituído e fora da janela devolvem null", async () => {
	const old = new Date(Date.now() - 3 * 60 * 60_000);
	const restore = fake([
		row(card("approved", APPROVED), { id: "a", conversationId: "conv-b" }),
		row(card("approved", APPROVED, "run1", "k2"), { id: "b" }),
		row(card("pending"), { id: "c", conversationId: "conv-p" }),
		row(card("rejected", { ok: false, detail: "substituído por um pedido mais novo" }), { id: "d", conversationId: "conv-s" }),
		row(card("approved", APPROVED), { id: "e", conversationId: "conv-old", createdAt: old }),
	]);
	try {
		assert.equal(await takeToolCallApproval("user-a", "conv", "k1", "run1"), null);
		assert.equal(await takeToolCallApproval("user-b", "conv-b", "k1", "run1"), null);
		assert.equal(await takeToolCallApproval("user-a", "conv-p", "k1", "run1"), null);
		assert.equal(await takeToolCallApproval("user-a", "conv-s", "k1", "run1"), null);
		assert.equal(await takeToolCallApproval("user-a", "conv-old", "k1", "run1"), null);
		// Mesma conversa e chamada, cartão certo: agora sim.
		assert.equal(await takeToolCallApproval("user-a", "conv-b", "k1", "run1"), "approved");
	} finally {
		restore();
	}
});

test("dois runs ao mesmo tempo: só um usa a aprovação", async () => {
	const rows = [row(card("approved", APPROVED))];
	const restore = fake(rows);
	try {
		const both = await Promise.all([takeToolCallApproval("user-a", "conv", "k1", "run1"), takeToolCallApproval("user-a", "conv", "k1", "run1")]);
		assert.deepEqual(both.filter((value) => value === "approved"), ["approved"]);
	} finally {
		restore();
	}
});

test("rascunho descartado ou ignorado: lido sem consumir, marcado só depois, só na conversa do dono (PR8e)", async () => {
	const { listPendingDraftDecisions, markDraftDecisionsNoted } = await import("./conversations.js");
	const confirm = (confirmId: string, title: string, detail: string, extra: Record<string, unknown> = {}) =>
		serializeConversationCard({ v: 1, kind: "confirm", confirmId, title, status: "rejected", outcome: { ok: false, detail }, ...extra } as Parameters<typeof serializeConversationCard>[0]);
	const rows = [
		row(confirm("confirm-draftabcd1234-runR", "Trello: update card?", "Descartado"), { id: "m1", createdAt: new Date(Date.now() - 3_000) }),
		row(confirm("confirm-toolabcd1234-runR", "Enviar esta mensagem?", "Dispensado", { draftDecision: "ignored" }), { id: "m2", createdAt: new Date(Date.now() - 2_000) }),
		// Cartão comum ignorado (não é rascunho): o modelo já recebe a fala nova como resultado; não vira nota.
		row(confirm("confirm-toolabcd1234-run1", "Outro?", "Dispensado"), { id: "m3", createdAt: new Date(Date.now() - 1_000) }),
	];
	const restore = fake(rows);
	const original = prisma.conversationMessage.findMany;
	try {
		assert.deepEqual(await listPendingDraftDecisions("user-b", "conv"), []);
		const pending = await listPendingDraftDecisions("user-a", "conv");
		assert.deepEqual(pending, [{ id: "m1", title: "Trello: update card?", decision: "dismissed" }, { id: "m2", title: "Enviar esta mensagem?", decision: "ignored" }]);
		// Ler não consome: um run que falha antes do passo 1 deixa a nota para o próximo.
		assert.equal((await listPendingDraftDecisions("user-a", "conv")).length, 2);
		const inIds = prisma.conversationMessage.findMany;
		prisma.conversationMessage.findMany = (async (args: { where: { id?: { in: string[] } } }) => (await inIds(args as never)).filter((item: { id: string }) => !args.where.id || args.where.id.in.includes(item.id))) as unknown as typeof prisma.conversationMessage.findMany;
		assert.equal(await markDraftDecisionsNoted("user-b", "conv", ["m1", "m2"]), 0);
		assert.equal(await markDraftDecisionsNoted("user-a", "conv", ["m1", "m2"]), 2);
		prisma.conversationMessage.findMany = inIds;
		assert.match(rows[0]!.content, /"modelNoted":true/);
		assert.match(rows[0]!.content, /"detail":"Descartado"/);
		assert.deepEqual(await listPendingDraftDecisions("user-a", "conv"), []);
	} finally {
		prisma.conversationMessage.findMany = original;
		restore();
	}
});
