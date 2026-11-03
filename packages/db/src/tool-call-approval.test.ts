import assert from "node:assert/strict";
import { test } from "node:test";
import { serializeConversationCard } from "@workspace/shared";
import { prisma } from "./client.js";
import { TOOL_CALL_CONSUMED_DETAIL, takeToolCallApproval } from "./conversations.js";

type Row = { id: string; content: string; createdAt: Date; ownerId: string };

/** Cartões em memória; o filtro de dono do `findMany` é aplicado aqui como no banco. */
function fake(rows: Row[]) {
	const original = { findMany: prisma.conversationMessage.findMany, updateMany: prisma.conversationMessage.updateMany };
	prisma.conversationMessage.findMany = (async (args: { where: { conversation?: { userId?: string } } }) =>
		rows.filter((row) => !args.where.conversation?.userId || row.ownerId === args.where.conversation.userId)) as unknown as typeof prisma.conversationMessage.findMany;
	prisma.conversationMessage.updateMany = (async (args: { where: { id: string; content: string }; data: { content: string } }) => {
		const row = rows.find((item) => item.id === args.where.id && item.content === args.where.content);
		if (!row) return { count: 0 };
		row.content = args.data.content;
		return { count: 1 };
	}) as unknown as typeof prisma.conversationMessage.updateMany;
	return () => Object.assign(prisma.conversationMessage, original);
}
const card = (status: "pending" | "approved" | "rejected", outcome?: { ok: boolean; detail: string }) =>
	serializeConversationCard({ v: 1, kind: "confirm", confirmId: "confirm-toolabc-run1", title: "Criar um link público do painel?", status, callKey: "k1", ...(outcome ? { outcome } : {}) } as Parameters<typeof serializeConversationCard>[0]);

test("aprovação de tool nativa vale para UMA execução", async () => {
	const rows: Row[] = [{ id: "m1", content: card("approved", { ok: true, detail: "aprovado pelo usuário" }), createdAt: new Date(), ownerId: "user-a" }];
	const restore = fake(rows);
	try {
		assert.equal(await takeToolCallApproval("user-a", "conv", "k1"), "approved");
		assert.match(rows[0]!.content, new RegExp(TOOL_CALL_CONSUMED_DETAIL));
		assert.equal(await takeToolCallApproval("user-a", "conv", "k1"), null);
	} finally {
		restore();
	}
});

test("recusa devolve declined; pendente, outra chamada ou outro dono devolvem null", async () => {
	const restore = fake([{ id: "m1", content: card("rejected", { ok: false, detail: "não aprovado pelo usuário" }), createdAt: new Date(), ownerId: "user-a" }]);
	try {
		assert.equal(await takeToolCallApproval("user-a", "conv", "k1"), "declined");
		assert.equal(await takeToolCallApproval("user-a", "conv", "k2"), null);
		assert.equal(await takeToolCallApproval("user-b", "conv", "k1"), null);
	} finally {
		restore();
	}
	const pending = fake([{ id: "m1", content: card("pending"), createdAt: new Date(), ownerId: "user-a" }]);
	try {
		assert.equal(await takeToolCallApproval("user-a", "conv", "k1"), null);
	} finally {
		pending();
	}
});
