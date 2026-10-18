import assert from "node:assert/strict";
import { test } from "node:test";
import { prisma } from "./client.js";
import { persistJevStatusCard } from "./conversations.js";

const card = {
	v: 1 as const,
	kind: "jev-status" as const,
	runId: "run-1",
	toolCallId: "call-1",
	mode: "gate" as const,
	result: "allow" as const,
	ok: true,
};

test("marcador JEV persiste uma vez e só na conversa do dono", async () => {
	const conversation = prisma.conversation as unknown as Record<string, unknown>;
	const message = prisma.conversationMessage as unknown as Record<string, unknown>;
	const originals = {
		findFirst: conversation.findFirst,
		findUnique: conversation.findUnique,
		findMany: message.findMany,
		create: message.create,
	};
	const rows: Array<{ id: string; conversationId: string; role: string; content: string; createdAt: Date }> = [];
	let owner = "user-a";
	conversation.findFirst = async ({ where }: { where: { userId: string; bot: { is: { ownerId: string } } } }) =>
		where.userId === owner && where.bot.is.ownerId === owner ? { id: "conv-1" } : null;
	conversation.findUnique = async () => ({ id: "conv-1" });
	message.findMany = async () => rows;
	message.create = async ({ data }: { data: { conversationId: string; role: string; content: string } }) => {
		const row = { id: `message-${rows.length + 1}`, ...data, createdAt: new Date() };
		rows.push(row);
		return row;
	};
	try {
		assert.equal(await persistJevStatusCard("conv-1", "user-b", card), null);
		assert.equal(rows.length, 0);
		const cardWithExtra = { ...card, args: { token: "secret" } };
		const first = await persistJevStatusCard("conv-1", owner, cardWithExtra);
		assert.equal(first?.role, "jev-status");
		assert.deepEqual(JSON.parse(rows[0]!.content), card);
		const second = await persistJevStatusCard("conv-1", owner, card);
		assert.equal(second?.id, first?.id);
		assert.equal(rows.length, 1);
		owner = "user-b";
		assert.equal(await persistJevStatusCard("conv-1", "user-a", { ...card, toolCallId: "call-2" }), null);
		assert.equal(rows.length, 1);
	} finally {
		conversation.findFirst = originals.findFirst;
		conversation.findUnique = originals.findUnique;
		message.findMany = originals.findMany;
		message.create = originals.create;
	}
});
