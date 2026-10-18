import assert from "node:assert/strict";
import { test } from "node:test";
import { getStrictMcpConnection, getStrictOwnedConversation, prisma } from "@workspace/db";

test("confirmação consulta conversa pelo dono exato e pelo dono do bot", async () => {
	const original = prisma.conversation.findFirst;
	let where: unknown;
	prisma.conversation.findFirst = (async (args: { where: unknown }) => {
		where = args.where;
		return { id: "conv-a", bot: { id: "bot-a" } };
	}) as unknown as typeof prisma.conversation.findFirst;
	try {
		assert.deepEqual(await getStrictOwnedConversation("conv-a", "user-a"), { id: "conv-a", botId: "bot-a" });
		assert.deepEqual(where, { id: "conv-a", userId: "user-a", bot: { is: { ownerId: "user-a" } } });
	} finally {
		prisma.conversation.findFirst = original;
	}
});

test("confirmação consulta conector pelo dono exato", async () => {
	const original = prisma.mcpConnection.findFirst;
	let where: unknown;
	prisma.mcpConnection.findFirst = (async (args: { where: unknown }) => {
		where = args.where;
		return null;
	}) as unknown as typeof prisma.mcpConnection.findFirst;
	try {
		assert.equal(await getStrictMcpConnection("conn-a", "user-a"), null);
		assert.deepEqual(where, { id: "conn-a", userId: "user-a" });
	} finally {
		prisma.mcpConnection.findFirst = original;
	}
});
