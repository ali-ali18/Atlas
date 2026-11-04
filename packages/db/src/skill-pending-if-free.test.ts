import assert from "node:assert/strict";
import { test } from "node:test";
import { prisma } from "./client.js";
import { saveSkillPendingIntentIfFree } from "./skill-pending.js";

type Row = { conversationId: string; userId: string; payload: unknown; expiresAt: Date };

/** Tabela em memória com a regra real: uma linha por conversa (índice único → P2002). */
function fakeTable(rows: Row[]) {
	const originals = { create: prisma.skillPendingIntent.create, updateMany: prisma.skillPendingIntent.updateMany };
	prisma.skillPendingIntent.create = (async (args: { data: Row }) => {
		if (rows.some((row) => row.conversationId === args.data.conversationId)) throw Object.assign(new Error("unique"), { code: "P2002" });
		rows.push(args.data);
		return args.data;
	}) as unknown as typeof prisma.skillPendingIntent.create;
	prisma.skillPendingIntent.updateMany = (async (args: { where: { conversationId: string; expiresAt: { lte: Date } }; data: Partial<Row> }) => {
		const hit = rows.filter((row) => row.conversationId === args.where.conversationId && row.expiresAt <= args.where.expiresAt.lte);
		for (const row of hit) Object.assign(row, args.data);
		return { count: hit.length };
	}) as unknown as typeof prisma.skillPendingIntent.updateMany;
	return () => Object.assign(prisma.skillPendingIntent, originals);
}

const save = (action: string) => saveSkillPendingIntentIfFree({ userId: "user-a", conversationId: "conv-1", payload: { kind: "confirm", action: action as "step-limit", confirmId: `confirm-${action}` } });

test("conversa sem pedido: grava", async () => {
	const rows: Row[] = [];
	const restore = fakeTable(rows);
	try {
		assert.equal(await save("step-limit"), true);
		assert.equal(rows.length, 1);
	} finally { restore(); }
});

test("pedido vivo do dono (plano): não sobrescreve e devolve false", async () => {
	const rows: Row[] = [{ conversationId: "conv-1", userId: "user-a", payload: { action: "plan" }, expiresAt: new Date(Date.now() + 60_000) }];
	const restore = fakeTable(rows);
	try {
		assert.equal(await save("step-limit"), false);
		assert.deepEqual(rows[0]!.payload, { action: "plan" });
	} finally { restore(); }
});

test("pedido vencido: é trocado", async () => {
	const rows: Row[] = [{ conversationId: "conv-1", userId: "user-a", payload: { action: "plan" }, expiresAt: new Date(Date.now() - 1_000) }];
	const restore = fakeTable(rows);
	try {
		assert.equal(await save("step-limit"), true);
		assert.equal((rows[0]!.payload as { action: string }).action, "step-limit");
	} finally { restore(); }
});
