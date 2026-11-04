import assert from "node:assert/strict";
import { test } from "node:test";
import { prisma } from "./client.js";
import { findConfirmCardTitle } from "./conversations.js";

/** Auditoria do PR #131: o título do cartão recusado só sai da conversa do próprio dono (filtro na consulta). */
test("findConfirmCardTitle: o dono lê o título; usuário B não lê o cartão do usuário A", async () => {
	const conversations = new Map([["conv-a", "user-a"]]);
	const rows = [{ id: "m1", conversationId: "conv-a", role: "confirm", content: JSON.stringify({ v: 1, kind: "confirm", confirmId: "c1", title: "Enviar esta mensagem?", status: "pending" }), createdAt: new Date() }];
	const original = prisma.conversationMessage.findMany;
	const wheres: unknown[] = [];
	prisma.conversationMessage.findMany = (async (args: { where: { conversationId: string; role: string; conversation?: { userId?: string } } }) => {
		wheres.push(args.where);
		const owner = args.where.conversation?.userId;
		return rows.filter((row) => row.conversationId === args.where.conversationId && row.role === args.where.role && (owner === undefined || conversations.get(row.conversationId) === owner));
	}) as unknown as typeof prisma.conversationMessage.findMany;
	try {
		assert.equal(await findConfirmCardTitle("conv-a", "user-a", "c1"), "Enviar esta mensagem?");
		assert.equal(await findConfirmCardTitle("conv-a", "user-b", "c1"), undefined);
		assert.equal(await findConfirmCardTitle("conv-a", "default", "c1"), undefined);
		assert.ok(wheres.every((where) => (where as { conversation?: { userId?: string } }).conversation?.userId), "a consulta sempre filtra pelo dono");
	} finally {
		prisma.conversationMessage.findMany = original;
	}
});
