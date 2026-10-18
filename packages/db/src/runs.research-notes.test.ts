/**
 * F3 — notas de pesquisa de runs anteriores da conversa: só do dono e da
 * conversa pedida; o run atual fica de fora. Prisma stubado (honra o `where`).
 * Runner: `pnpm exec tsx --test src/runs.research-notes.test.ts` em packages/db.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";
const { prisma } = await import("./client.js");
const { listConversationResearchNotes } = await import("./runs.js");

type Row = { id: string; userId: string; conversationId: string; createdAt: Date; checkpointJson: unknown };
const note = (ref: string) => ({ sourceRef: ref, findings: "x", keyFacts: [], links: [], confidence: "high", step: 1 });

test("notas anteriores: só do dono, só da conversa, sem o run atual", async () => {
	const rows: Row[] = [
		{ id: "r1", userId: "user-a", conversationId: "conv-1", createdAt: new Date(1), checkpointJson: { researchNotes: [note("https://a.test/1")] } },
		{ id: "r2", userId: "user-a", conversationId: "conv-1", createdAt: new Date(2), checkpointJson: { researchNotes: [note("https://a.test/2")] } },
		{ id: "r3", userId: "user-a", conversationId: "conv-1", createdAt: new Date(3), checkpointJson: { researchNotes: [note("https://a.test/atual")] } },
		{ id: "r4", userId: "user-b", conversationId: "conv-1", createdAt: new Date(4), checkpointJson: { researchNotes: [note("https://b.test/segredo")] } },
		{ id: "r5", userId: "user-a", conversationId: "conv-2", createdAt: new Date(5), checkpointJson: { researchNotes: [note("https://a.test/outra-conversa")] } },
		{ id: "r6", userId: "user-a", conversationId: "conv-1", createdAt: new Date(0), checkpointJson: { messages: [] } },
	];
	const agentRun = prisma.agentRun as unknown as Record<string, unknown>;
	const original = agentRun.findMany;
	agentRun.findMany = async ({ where, orderBy, take }: { where: { conversationId: string; userId: { in: string[] }; id?: { not: string } }; orderBy: { createdAt: "desc" }; take: number }) => {
		assert.equal(orderBy.createdAt, "desc");
		return rows
			.filter((row) => row.conversationId === where.conversationId && where.userId.in.includes(row.userId) && row.id !== where.id?.not)
			.sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime())
			.slice(0, take)
			.map((row) => ({ checkpointJson: row.checkpointJson }));
	};
	try {
		const own = await listConversationResearchNotes("user-a", "conv-1", { excludeRunId: "r3" });
		assert.deepEqual(own.map((item) => item.sourceRef), ["https://a.test/1", "https://a.test/2"]);
		// Usuário B não lê as notas do usuário A, nem na mesma conversa.
		const other = await listConversationResearchNotes("user-b", "conv-1");
		assert.deepEqual(other.map((item) => item.sourceRef), ["https://b.test/segredo"]);
		assert.deepEqual(await listConversationResearchNotes("user-c", "conv-1"), []);
		assert.deepEqual(await listConversationResearchNotes("user-a", ""), []);
	} finally {
		agentRun.findMany = original;
	}
});
