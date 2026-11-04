import assert from "node:assert/strict";
import { test } from "node:test";
import { prisma } from "./client.js";
import { getConversationTaskList } from "./runs.js";

type Row = { id: string; userId: string; conversationId: string; createdAt: Date; checkpointJson: unknown };

/** Runs em memória; os filtros de dono, conversa e exclusão do `findMany` são aplicados aqui como no banco. */
function fake(rows: Row[]) {
	const original = prisma.agentRun.findMany;
	prisma.agentRun.findMany = (async (args: { where: { conversationId: string; userId: { in: string[] }; id?: { not: string } }; take?: number }) =>
		rows
			.filter((row) => row.conversationId === args.where.conversationId && args.where.userId.in.includes(row.userId) && row.id !== args.where.id?.not)
			.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
			.slice(0, args.take ?? 3)) as unknown as typeof prisma.agentRun.findMany;
	return () => {
		prisma.agentRun.findMany = original;
	};
}
const at = (minutes: number) => new Date(Date.UTC(2026, 10, 4, 12, minutes));
const OPEN = [{ content: "Levantar preços", status: "completed" }, { content: "Comparar fornecedores", status: "in_progress" }, { content: "Montar o relatório", status: "pending" }];

test("motor v3 (PR8e): a lista aberta do run anterior vem do estado do v3, só para o dono", async () => {
	const restore = fake([{ id: "r1", userId: "user-a", conversationId: "conv", createdAt: at(1), checkpointJson: { engine: "v3", engineV3: { ownTaskList: OPEN } } }]);
	try {
		assert.deepEqual((await getConversationTaskList("user-a", "conv", { engineV3: true }))?.map((item) => item.status), ["completed", "in_progress", "pending"]);
		assert.equal(await getConversationTaskList("user-b", "conv", { engineV3: true }), null);
		assert.equal(await getConversationTaskList("user-a", "conv", { excludeRunId: "r1", engineV3: true }), null);
		// v1/v2 não herdam a lista de um run do v3 (conversa que trocou de motor).
		assert.equal(await getConversationTaskList("user-a", "conv"), null);
	} finally {
		restore();
	}
});

test("o run v3 mais recente decide: sem lista (ou com a lista concluída) a lista de um run antigo não volta", async () => {
	const restore = fake([
		{ id: "old", userId: "user-a", conversationId: "conv", createdAt: at(1), checkpointJson: { taskState: { taskList: OPEN } } },
		{ id: "new", userId: "user-a", conversationId: "conv", createdAt: at(2), checkpointJson: { engine: "v3", engineV3: { nudges: {} } } },
	]);
	try {
		assert.equal(await getConversationTaskList("user-a", "conv", { engineV3: true }), null);
		// Para v1/v2 o run v3 é invisível, como antes desta mudança: vale a lista do v2.
		assert.equal((await getConversationTaskList("user-a", "conv"))?.length, 3);
		// v2 continua igual: a lista do `taskState` vale quando é o run mais recente.
		assert.equal((await getConversationTaskList("user-a", "conv", { excludeRunId: "new" }))?.length, 3);
	} finally {
		restore();
	}
});
