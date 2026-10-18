import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConversationCard, serializeConversationCard } from "@workspace/shared";
import { prisma } from "@workspace/db";
import { maybeHandleConfirmedAction } from "./confirmed-action.js";

const card = {
	v: 1 as const,
	kind: "confirm" as const,
	confirmId: "confirm-run-1",
	title: 'Google Agenda: executar "create_event"?',
	status: "pending" as const,
};

/** Dublê do banco: intenção pendente já expirada (TTL de 10 min), card ainda pendente. */
function stubDb(ownerOk: boolean) {
	const orig = {
		pending: prisma.skillPendingIntent.findUnique,
		conv: prisma.conversation.findFirst,
		find: prisma.conversationMessage.findMany,
		update: prisma.conversationMessage.update,
	};
	const updates: Array<{ id: string; content: string }> = [];
	const row = { id: "m1", conversationId: "c1", role: "confirm", content: serializeConversationCard(card), createdAt: new Date() };
	prisma.skillPendingIntent.findUnique = (async () => null) as unknown as typeof prisma.skillPendingIntent.findUnique;
	prisma.conversation.findFirst = (async () => (ownerOk ? { id: "c1" } : null)) as unknown as typeof prisma.conversation.findFirst;
	prisma.conversationMessage.findMany = (async () => [row]) as unknown as typeof prisma.conversationMessage.findMany;
	prisma.conversationMessage.update = (async (args: { where: { id: string }; data: { content: string } }) => {
		updates.push({ id: args.where.id, content: args.data.content });
		return row;
	}) as unknown as typeof prisma.conversationMessage.update;
	return {
		updates,
		restore() {
			prisma.skillPendingIntent.findUnique = orig.pending;
			prisma.conversation.findFirst = orig.conv;
			prisma.conversationMessage.findMany = orig.find;
			prisma.conversationMessage.update = orig.update;
		},
	};
}

const base = { text: "cancela isso", userId: "user-a", botId: "bot-a", conversationId: "c1", model: "m" };

test("cancelar depois da intenção expirar persiste o card como rejected (F5 não volta pending)", async () => {
	const db = stubDb(true);
	try {
		const result = await maybeHandleConfirmedAction(base);
		assert.equal(result.handled, false);
		assert.equal(db.updates.length, 1);
		const saved = parseConversationCard(db.updates[0]!.content);
		assert.equal(saved?.kind === "confirm" ? saved.status : null, "rejected");
	} finally {
		db.restore();
	}
});

test("cancelar em conversa de outro usuário não altera o card", async () => {
	const db = stubDb(false);
	try {
		await maybeHandleConfirmedAction({ ...base, userId: "user-b" });
		assert.equal(db.updates.length, 0);
	} finally {
		db.restore();
	}
});
