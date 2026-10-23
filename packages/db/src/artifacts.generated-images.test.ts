/**
 * Imagens geradas da conversa (alias `generated:latest` dos slides): só do dono, só da conversa, da mais
 * nova para a mais antiga. Prisma stubado. Runner: `pnpm exec tsx --test src/artifacts.generated-images.test.ts` em packages/db.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";
const { prisma } = await import("./client.js");
const { listGeneratedImageIds } = await import("./artifacts.js");

type Row = { id: string; userId: string; conversationId: string; kind: string; metaJson: { source: string }; createdAt: number };

test("listGeneratedImageIds: filtra por dono, conversa, tipo e origem; mais recente primeiro", async () => {
	const rows: Row[] = [
		{ id: "gen-old", userId: "user-a", conversationId: "conv-1", kind: "image", metaJson: { source: "generated" }, createdAt: 1 },
		{ id: "gen-new", userId: "user-a", conversationId: "conv-1", kind: "image", metaJson: { source: "generated" }, createdAt: 3 },
		{ id: "upload", userId: "user-a", conversationId: "conv-1", kind: "image", metaJson: { source: "upload" }, createdAt: 4 },
		{ id: "other-conv", userId: "user-a", conversationId: "conv-2", kind: "image", metaJson: { source: "generated" }, createdAt: 5 },
		{ id: "other-user", userId: "user-b", conversationId: "conv-1", kind: "image", metaJson: { source: "generated" }, createdAt: 6 },
	];
	const artifact = prisma.artifact as unknown as Record<string, unknown>;
	const original = artifact.findMany;
	let lastWhere: Record<string, unknown> = {};
	artifact.findMany = async ({ where, take }: { where: { conversationId: string; userId: { in: string[] }; kind: string; metaJson: { equals: string } }; take: number }) => {
		lastWhere = where;
		return rows
			.filter((r) => r.conversationId === where.conversationId && where.userId.in.includes(r.userId) && r.kind === where.kind && r.metaJson.source === where.metaJson.equals)
			.sort((a, b) => b.createdAt - a.createdAt)
			.slice(0, take)
			.map((r) => ({ id: r.id }));
	};
	try {
		assert.deepEqual(await listGeneratedImageIds("user-a", "conv-1"), ["gen-new", "gen-old"]);
		assert.deepEqual(await listGeneratedImageIds("user-a", "conv-1", 1), ["gen-new"]);
		// outro usuário não enxerga as imagens do A; A não enxerga as do B
		assert.deepEqual(await listGeneratedImageIds("user-b", "conv-1"), ["other-user"]);
		assert.deepEqual(await listGeneratedImageIds("user-c", "conv-1"), []);
		assert.equal((lastWhere.metaJson as { path: string[] }).path[0], "source");
		// sem dono ou conversa: nada, nem consulta
		assert.deepEqual(await listGeneratedImageIds("", "conv-1"), []);
		assert.deepEqual(await listGeneratedImageIds("user-a", ""), []);
	} finally {
		artifact.findMany = original;
	}
});
