/**
 * V3 — ledger de itens herdado entre runs da mesma conversa: só do dono e da
 * conversa pedida; o run atual fica de fora; tarefa concluída não é herdada.
 * Prisma stubado (honra o `where`).
 * Runner: `pnpm exec tsx --test src/runs.task-ledger.test.ts` em packages/db.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";
const { prisma } = await import("./client.js");
const { getConversationTaskLedger } = await import("./runs.js");

type Row = { id: string; userId: string; conversationId: string; createdAt: Date; checkpointJson: unknown };
const item = (id: string, status: string) => ({ id, label: `Week ${id}`, status, ...(status === "done" ? { evidence: "read" } : {}) });
const ledger = (...items: Array<[string, string]>) => ({
	taskState: { v: 1, objective: { text: "x", version: 1 }, ledger: { v: 1, items: items.map(([id, status]) => item(id, status)) } },
});

test("ledger herdado: só do dono, só da conversa, sem o run atual, só com item aberto", async () => {
	const rows: Row[] = [
		{ id: "r1", userId: "user-a", conversationId: "conv-1", createdAt: new Date(1), checkpointJson: ledger(["1", "done"], ["2", "pending"]) },
		{ id: "r3", userId: "user-a", conversationId: "conv-1", createdAt: new Date(3), checkpointJson: ledger(["9", "pending"]) },
		{ id: "r4", userId: "user-b", conversationId: "conv-1", createdAt: new Date(4), checkpointJson: ledger(["7", "pending"]) },
		{ id: "r5", userId: "user-a", conversationId: "conv-2", createdAt: new Date(5), checkpointJson: ledger(["8", "pending"]) },
		{ id: "r6", userId: "user-c", conversationId: "conv-3", createdAt: new Date(6), checkpointJson: ledger(["1", "done"]) },
		{ id: "r7", userId: "user-c", conversationId: "conv-3", createdAt: new Date(2), checkpointJson: ledger(["1", "pending"]) },
		{ id: "r8", userId: "user-a", conversationId: "conv-1", createdAt: new Date(0), checkpointJson: { messages: [] } },
	];
	const agentRun = prisma.agentRun as unknown as Record<string, unknown>;
	const original = agentRun.findMany;
	agentRun.findMany = async ({ where, take }: { where: { conversationId: string; userId: { in: string[] }; id?: { not: string } }; take: number }) =>
		rows
			.filter((row) => row.conversationId === where.conversationId && where.userId.in.includes(row.userId) && row.id !== where.id?.not)
			.sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime())
			.slice(0, take)
			.map((row) => ({ checkpointJson: row.checkpointJson }));
	try {
		const own = await getConversationTaskLedger("user-a", "conv-1", { excludeRunId: "r3" });
		assert.deepEqual(own?.items.map((entry) => entry.id), ["1", "2"]);
		// O run atual não se herda a si mesmo; sem excluir, vale o mais recente.
		assert.deepEqual((await getConversationTaskLedger("user-a", "conv-1"))?.items.map((entry) => entry.id), ["9"]);
		// Usuário B não lê o ledger do usuário A, nem na mesma conversa.
		assert.deepEqual((await getConversationTaskLedger("user-b", "conv-1"))?.items.map((entry) => entry.id), ["7"]);
		assert.equal(await getConversationTaskLedger("user-c", "conv-1"), null);
		assert.equal(await getConversationTaskLedger("user-a", ""), null);
		// O mais recente com ledger está concluído: não herda o antigo aberto.
		assert.equal(await getConversationTaskLedger("user-c", "conv-3"), null);
	} finally {
		agentRun.findMany = original;
	}
});
