/**
 * Limites de memória contra Postgres real (mesmos cenários de memory-limits.test.ts, mas com
 * Prisma de verdade + pgvector). Pulado sem ATLAS_TEST_DB_URL.
 * Runner: `pnpm --filter @workspace/db test:db`.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { prisma } from "./client.js";
import {
	MEMORY_CHAR_LIMIT,
	USER_CHAR_LIMIT,
	addMemoryEntry,
	getMemorySnapshot,
	memoryLimitFor,
	removeMemoryEntry,
	replaceMemoryEntry,
} from "./memory-entries.js";
import { createTestBot, createTestUser, dbSkip } from "./testing/test-db.js";

describe("memory-entries (Postgres real)", { skip: dbSkip }, () => {
	let userId: string;
	let otherUserId: string;
	let orqId: string;
	let finId: string;

	before(async () => {
		delete process.env.OPENROUTER_API_KEY; // sem embedding: salva sem vetor
		userId = (await createTestUser("mem")).id;
		otherUserId = (await createTestUser("mem-other")).id;
		orqId = (await createTestBot(userId, { isPrimary: true })).id;
		finId = (await createTestBot(userId, { name: "fin" })).id;
	});
	after(async () => {
		await prisma.$disconnect();
	});

	test("pgvector está instalado e a coluna embedding aceita vetores", async () => {
		const [row] = await prisma.$queryRaw<Array<{ d: number }>>`SELECT '[1,0,0]'::vector <=> '[0,1,0]'::vector AS d`;
		assert.equal(Number(row!.d), 1);
		const created = await prisma.memoryEntry.create({ data: { userId, target: "user", content: "vec-teste" } });
		const literal = `[${Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0)).join(",")}]`;
		await prisma.$executeRaw`UPDATE memory_entries SET embedding = ${literal}::vector WHERE id = ${created.id}`;
		const near = await prisma.$queryRaw<Array<{ id: string; distance: number }>>`
			SELECT id, embedding <=> ${literal}::vector AS distance FROM memory_entries WHERE id = ${created.id}`;
		assert.equal(Number(near[0]!.distance), 0);
		await prisma.memoryEntry.delete({ where: { id: created.id } });
	});

	test("limites: orquestrador usa o padrão da conta (6000); outros bots e perfil user, o fixo", async () => {
		assert.equal(await memoryLimitFor(userId, orqId, "memory"), 6000);
		assert.equal(await memoryLimitFor(userId, finId, "memory"), MEMORY_CHAR_LIMIT);
		assert.equal(await memoryLimitFor(userId, orqId, "user"), USER_CHAR_LIMIT);
		assert.equal(await memoryLimitFor(otherUserId, orqId, "memory"), MEMORY_CHAR_LIMIT, "bot principal de outro dono não vale");
	});

	test("bot comum: recusa além de 2200 chars, no limite exato aceita, duplicado e vazio recusados", async () => {
		const ok = await addMemoryEntry({ userId, botId: finId, target: "memory", content: "a".repeat(MEMORY_CHAR_LIMIT - 10) });
		assert.equal(ok.ok, true);
		const exact = await addMemoryEntry({ userId, botId: finId, target: "memory", content: "b".repeat(10) });
		assert.equal(exact.ok, true, "chegar exatamente no limite é permitido");
		const over = await addMemoryEntry({ userId, botId: finId, target: "memory", content: "c" });
		assert.equal(over.ok, false);
		assert.match((over as { error: string }).error, /limite de 2200/);
		const dup = await addMemoryEntry({ userId, botId: finId, target: "memory", content: "b".repeat(10) });
		assert.equal((dup as { error: string }).error, "duplicado");
		const empty = await addMemoryEntry({ userId, botId: finId, target: "memory", content: "   " });
		assert.equal((empty as { error: string }).error, "conteúdo vazio");
		const snap = await getMemorySnapshot(userId, finId);
		assert.equal(snap.memory.usage.used, MEMORY_CHAR_LIMIT);
	});

	test("orquestrador comporta mais que 2200 e a memória de um bot não vaza para outro nem para outro dono", async () => {
		const big = await addMemoryEntry({ userId, botId: orqId, target: "memory", content: "o".repeat(5000) });
		assert.equal(big.ok, true);
		const tooBig = await addMemoryEntry({ userId, botId: orqId, target: "memory", content: "p".repeat(1500) });
		assert.equal(tooBig.ok, false);
		assert.equal((await getMemorySnapshot(userId, orqId)).memory.entries.length, 1);
		assert.equal((await getMemorySnapshot(userId, finId)).memory.entries.length, 2);
		assert.equal((await getMemorySnapshot(otherUserId, finId)).memory.entries.length, 0);
	});

	test("perfil user: limite 1375 e replace/remove respeitam o dono", async () => {
		const first = await addMemoryEntry({ userId, target: "user", content: "gosta de café" });
		assert.equal(first.ok, true);
		const over = await addMemoryEntry({ userId, target: "user", content: "x".repeat(USER_CHAR_LIMIT) });
		assert.match((over as { error: string }).error, /limite de 1375/);
		// outro usuário não enxerga nem altera
		const foreignReplace = await replaceMemoryEntry({ userId: otherUserId, target: "user", oldText: "café", content: "chá" });
		assert.equal(foreignReplace.ok, false);
		const replaced = await replaceMemoryEntry({ userId, target: "user", oldText: "café", content: "gosta de chá" });
		assert.equal(replaced.ok, true);
		const foreignRemove = await removeMemoryEntry({ userId: otherUserId, target: "user", oldText: "chá" });
		assert.equal(foreignRemove.ok, false);
		const removed = await removeMemoryEntry({ userId, target: "user", oldText: "chá" });
		assert.equal(removed.ok, true);
		assert.equal((await getMemorySnapshot(userId)).user.entries.length, 0);
	});
});
