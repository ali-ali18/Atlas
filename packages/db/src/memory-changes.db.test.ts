/**
 * Histórico de mudanças da memória + desfazer contra Postgres real. Pulado sem ATLAS_TEST_DB_URL.
 * Runner: `pnpm --filter @workspace/db test:db`.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { prisma } from "./client.js";
import { listMemoryChanges } from "./memory-changes.js";
import {
	MEMORY_CHAR_LIMIT,
	addMemoryEntry,
	getMemorySnapshot,
	removeMemoryEntry,
	removeMemoryEntryById,
	replaceMemoryEntry,
	replaceMemoryEntryById,
} from "./memory-entries.js";
import { undoMemoryChange } from "./memory-undo.js";
import { deleteOwnedMemory, updateOwnedMemory } from "./reflection.js";
import { createTestBot, createTestUser, dbSkip } from "./testing/test-db.js";

describe("memory-changes (Postgres real)", { skip: dbSkip }, () => {
	let userId: string;
	let otherUserId: string;
	let botId: string;

	before(async () => {
		delete process.env.OPENROUTER_API_KEY;
		userId = (await createTestUser("chg")).id;
		otherUserId = (await createTestUser("chg-other")).id;
		botId = (await createTestBot(userId, { name: "a" })).id;
	});
	after(async () => {
		await prisma.$disconnect();
	});

	const entryOf = async (id: string) => prisma.memoryEntry.findUnique({ where: { id } });
	const lastChange = async (entryId: string) => (await prisma.memoryChange.findMany({ where: { entryId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1 }))[0]!;
	const codeOf = (result: { ok: boolean; code?: string }) => (result.ok ? null : result.code);

	test("add/replace/remove da conversa gravam histórico com origem chat e antes/depois", async () => {
		const added = await addMemoryEntry({ userId, botId, target: "memory", content: "gosta de café", source: "agent-tool" });
		assert.ok(added.ok && added.entry);
		const id = added.entry.id;
		let change = await lastChange(id);
		assert.deepEqual([change.action, change.source, change.before, change.after, change.botId, change.target], ["add", "chat", null, "gosta de café", botId, "memory"]);

		await replaceMemoryEntry({ userId, botId, target: "memory", oldText: "café", content: "gosta de chá", source: "agent-tool" });
		change = await lastChange(id);
		assert.deepEqual([change.action, change.source, change.before, change.after], ["replace", "chat", "gosta de café", "gosta de chá"]);

		await removeMemoryEntry({ userId, botId, target: "memory", oldText: "chá" });
		change = await lastChange(id);
		assert.deepEqual([change.action, change.source, change.before, change.after], ["remove", "chat", "gosta de chá", null]);
	});

	test("origem: memory-review vira review, reflexao vira reflection; origin explícito (UI/API) vira user", async () => {
		const a = await addMemoryEntry({ userId, botId, target: "memory", content: "fato da revisão", source: "memory-review" });
		const b = await addMemoryEntry({ userId, botId, target: "memory", content: "fato da reflexão", source: "reflexao: diária" });
		const c = await addMemoryEntry({ userId, botId, target: "memory", content: "fato do usuário", source: "user", origin: "user" });
		assert.ok(a.ok && b.ok && c.ok);
		assert.equal((await lastChange(a.entry!.id)).source, "review");
		assert.equal((await lastChange(b.entry!.id)).source, "reflection");
		assert.equal((await lastChange(c.entry!.id)).source, "user");
		await removeMemoryEntry({ userId, botId, target: "memory", oldText: "fato da revisão", origin: "review" });
		assert.equal((await lastChange(a.entry!.id)).source, "review");
	});

	test("a reflexão (updateOwnedMemory/deleteOwnedMemory) grava histórico reflection", async () => {
		const added = await addMemoryEntry({ userId, botId, target: "memory", content: "pendência antiga" });
		const id = added.ok ? added.entry!.id : "";
		assert.equal(await updateOwnedMemory(userId, id, { content: "[RESOLVIDA] pendência antiga" }), true);
		let change = await lastChange(id);
		assert.deepEqual([change.action, change.source, change.before, change.after], ["replace", "reflection", "pendência antiga", "[RESOLVIDA] pendência antiga"]);
		assert.equal(await deleteOwnedMemory(otherUserId, id), false, "outro dono não apaga");
		assert.equal((await lastChange(id)).action, "replace");
		assert.equal(await deleteOwnedMemory(userId, id), true);
		change = await lastChange(id);
		assert.deepEqual([change.action, change.source, change.before], ["remove", "reflection", "[RESOLVIDA] pendência antiga"]);
	});

	test("edição/remoção por id (aba Memória) gravam origem user; id de outro usuário devolve null", async () => {
		const added = await addMemoryEntry({ userId, target: "user", content: "mora em Recife" });
		const id = added.ok ? added.entry!.id : "";
		assert.equal(await replaceMemoryEntryById({ userId: otherUserId, entryId: id, content: "invadido" }), null);
		assert.equal(await removeMemoryEntryById({ userId: otherUserId, entryId: id }), null);
		assert.equal((await entryOf(id))?.content, "mora em Recife");

		const edited = await replaceMemoryEntryById({ userId, entryId: id, content: "mora em Olinda" });
		assert.equal(edited?.ok, true);
		let change = await lastChange(id);
		assert.deepEqual([change.action, change.source, change.before, change.after], ["replace", "user", "mora em Recife", "mora em Olinda"]);
		// mesmo texto: não gera ruído
		const count = await prisma.memoryChange.count({ where: { entryId: id } });
		await replaceMemoryEntryById({ userId, entryId: id, content: "mora em Olinda" });
		assert.equal(await prisma.memoryChange.count({ where: { entryId: id } }), count);
		// as travas do replace valem na edição
		assert.equal((await replaceMemoryEntryById({ userId, entryId: id, content: "   " }))?.ok, false);

		assert.equal((await removeMemoryEntryById({ userId, entryId: id }))?.ok, true);
		change = await lastChange(id);
		assert.deepEqual([change.action, change.source], ["remove", "user"]);
	});

	test("desfazer add: apaga a entrada, registra o desfazer (user) e marca undoneAt", async () => {
		const added = await addMemoryEntry({ userId, botId, target: "memory", content: "item para desfazer add" });
		const entryId = added.ok ? added.entry!.id : "";
		const change = await lastChange(entryId);
		const undo = await undoMemoryChange({ userId, changeId: change.id });
		assert.equal(undo.ok, true);
		assert.equal(await entryOf(entryId), null);
		assert.ok((await prisma.memoryChange.findUnique({ where: { id: change.id } }))?.undoneAt);
		if (undo.ok) {
			assert.deepEqual([undo.change.action, undo.change.source, undo.change.undoOfId, undo.change.before], ["remove", "user", change.id, "item para desfazer add"]);
		}
		assert.equal(codeOf(await undoMemoryChange({ userId, changeId: change.id })), "already_undone");
	});

	test("desfazer replace restaura texto e metadados; o desfazer não pode ser desfeito", async () => {
		const added = await addMemoryEntry({ userId, botId, target: "memory", content: "versão 1", category: "contexto", importance: 0.9, source: "agent-tool" });
		const entryId = added.ok ? added.entry!.id : "";
		await replaceMemoryEntry({ userId, botId, target: "memory", oldText: "versão 1", content: "versão 2", category: "outra", importance: 0.1, source: "agent-tool" });
		const change = await lastChange(entryId);
		const undo = await undoMemoryChange({ userId, changeId: change.id });
		assert.equal(undo.ok, true);
		const row = await entryOf(entryId);
		assert.deepEqual([row?.content, row?.category, row?.importance], ["versão 1", "contexto", 0.9]);
		if (undo.ok) assert.equal(codeOf(await undoMemoryChange({ userId, changeId: undo.change.id })), "not_undoable");
	});

	test("desfazer remove recria a entrada (mesmo id e metadados)", async () => {
		const added = await addMemoryEntry({ userId, botId, target: "memory", content: "voltar depois", category: "contexto", importance: 0.7, source: "memory-review" });
		const entryId = added.ok ? added.entry!.id : "";
		await removeMemoryEntry({ userId, botId, target: "memory", oldText: "voltar depois", origin: "reflection" });
		assert.equal(await entryOf(entryId), null);
		const undo = await undoMemoryChange({ userId, changeId: (await lastChange(entryId)).id });
		assert.equal(undo.ok, true);
		const row = await entryOf(entryId);
		assert.deepEqual([row?.content, row?.botId, row?.target, row?.category, row?.importance, row?.source], ["voltar depois", botId, "memory", "contexto", 0.7, "memory-review"]);
		if (undo.ok) assert.deepEqual([undo.change.action, undo.change.source], ["add", "user"]);
	});

	test("recusa stale quando a entrada mudou depois (add, replace e remove), sem sobrescrever", async () => {
		// add → entrada editada depois
		const a = await addMemoryEntry({ userId, botId, target: "memory", content: "stale add" });
		const aId = a.ok ? a.entry!.id : "";
		const addChange = await lastChange(aId);
		await replaceMemoryEntryById({ userId, entryId: aId, content: "stale add editado" });
		const r1 = await undoMemoryChange({ userId, changeId: addChange.id });
		assert.equal(codeOf(r1), "stale");
		assert.match(r1.ok ? "" : r1.message, /alterada depois/);
		assert.equal((await entryOf(aId))?.content, "stale add editado");
		assert.equal((await prisma.memoryChange.findUnique({ where: { id: addChange.id } }))?.undoneAt, null, "recusa não marca undoneAt");

		// replace → entrada editada de novo
		const replaceChange = await lastChange(aId);
		await replaceMemoryEntryById({ userId, entryId: aId, content: "stale add terceira" });
		assert.equal(codeOf(await undoMemoryChange({ userId, changeId: replaceChange.id })), "stale");
		assert.equal((await entryOf(aId))?.content, "stale add terceira");

		// replace → entrada apagada
		await removeMemoryEntryById({ userId, entryId: aId });
		assert.equal(codeOf(await undoMemoryChange({ userId, changeId: replaceChange.id })), "stale");

		// remove → o mesmo texto já existe de novo
		const b = await addMemoryEntry({ userId, botId, target: "memory", content: "texto repetido" });
		const bId = b.ok ? b.entry!.id : "";
		await removeMemoryEntryById({ userId, entryId: bId });
		const removeChange = await lastChange(bId);
		await addMemoryEntry({ userId, botId, target: "memory", content: "texto repetido" });
		assert.equal(codeOf(await undoMemoryChange({ userId, changeId: removeChange.id })), "duplicate");
	});

	test("desfazer remove respeita o limite de caracteres", async () => {
		const bot = (await createTestBot(userId, { name: "cheio" })).id;
		const first = await addMemoryEntry({ userId, botId: bot, target: "memory", content: "x".repeat(MEMORY_CHAR_LIMIT - 5) });
		const id = first.ok ? first.entry!.id : "";
		await removeMemoryEntryById({ userId, entryId: id });
		const change = await lastChange(id);
		await addMemoryEntry({ userId, botId: bot, target: "memory", content: "y".repeat(MEMORY_CHAR_LIMIT - 10) });
		assert.equal(codeOf(await undoMemoryChange({ userId, changeId: change.id })), "limit");
	});

	test("isolamento: outro usuário não desfaz nem lista mudanças alheias", async () => {
		const added = await addMemoryEntry({ userId, target: "user", content: "segredo do perfil" });
		const entryId = added.ok ? added.entry!.id : "";
		const change = await lastChange(entryId);
		assert.equal(codeOf(await undoMemoryChange({ userId: otherUserId, changeId: change.id })), "not_found");
		assert.equal((await entryOf(entryId))?.content, "segredo do perfil");
		assert.equal((await prisma.memoryChange.findUnique({ where: { id: change.id } }))?.undoneAt, null);
		assert.equal((await listMemoryChanges({ userId: otherUserId, botId })).changes.length, 0);
		assert.equal((await getMemorySnapshot(otherUserId, botId)).user.entries.length, 0);
	});

	test("lista: perfil user aparece em todos os bots, memory só no bot dono; janela de 30 dias; paginação", async () => {
		const u = (await createTestUser("chg-list")).id;
		const b1 = (await createTestBot(u)).id;
		const b2 = (await createTestBot(u)).id;
		await addMemoryEntry({ userId: u, botId: b1, target: "user", content: "perfil" });
		await addMemoryEntry({ userId: u, botId: b1, target: "memory", content: "privado b1" });
		await addMemoryEntry({ userId: u, botId: b2, target: "memory", content: "privado b2" });
		const old = await addMemoryEntry({ userId: u, botId: b1, target: "memory", content: "antigo" });
		await prisma.memoryChange.updateMany({ where: { entryId: old.ok ? old.entry!.id : "" }, data: { createdAt: new Date(Date.now() - 31 * 86_400_000) } });

		const forB1 = await listMemoryChanges({ userId: u, botId: b1 });
		assert.deepEqual(forB1.changes.map((c) => c.after).sort(), ["perfil", "privado b1"]);
		const forB2 = await listMemoryChanges({ userId: u, botId: b2 });
		assert.deepEqual(forB2.changes.map((c) => c.after).sort(), ["perfil", "privado b2"]);

		const p1 = await listMemoryChanges({ userId: u, botId: b1, limit: 1 });
		assert.equal(p1.changes.length, 1);
		assert.ok(p1.nextCursor);
		const p2 = await listMemoryChanges({ userId: u, botId: b1, limit: 1, cursor: p1.nextCursor! });
		assert.equal(p2.changes.length, 1);
		assert.equal(p2.nextCursor, null);
		assert.notEqual(p1.changes[0]!.id, p2.changes[0]!.id);
	});

	test("o gatilho do hub publica um evento memory a cada mudança", async () => {
		const u = (await createTestUser("chg-evt")).id;
		const count = () => prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM user_events WHERE "userId" = ${u} AND type = 'memory'`.then((rows) => Number(rows[0]!.n));
		const before = await count();
		await addMemoryEntry({ userId: u, target: "user", content: "evento" });
		assert.equal(await count(), before + 1);
	});
});
