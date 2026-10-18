/**
 * Limite de memória por bot: só o bot principal (orquestrador) usa o limite próprio da conta; os
 * demais bots e o perfil `user` seguem o limite fixo. E o que entra no prompt sem pergunta.
 * Runner: `tsx --test src/memory-limits.test.ts` em packages/db.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { BOT_CHARS_FOR_TEST, entry } from "./memory-limits.helpers.js";
import { USER_CHAR_LIMIT, MEMORY_CHAR_LIMIT, addMemoryEntry, getMemorySnapshot, memoryLimitFor, promptMemoryView } from "./memory-entries.js";
import { FakeTable, installFakes } from "./testing/fake-tables.js";

let bots: FakeTable;
let settings: FakeTable;
let memories: FakeTable;
let changes: FakeTable;
let installed: { restore: () => void };

beforeEach(() => {
	delete process.env.OPENROUTER_API_KEY;
	bots = new FakeTable([
		{ id: "orq", ownerId: "u1", isPrimary: true },
		{ id: "fin", ownerId: "u1", isPrimary: false },
		{ id: "other-orq", ownerId: "u2", isPrimary: true },
	]);
	settings = new FakeTable([]);
	memories = new FakeTable([], () => ({ createdAt: new Date(), updatedAt: new Date(), importance: 0, confidence: null, category: null, source: null, validUntil: null, access: "private" }));
	changes = new FakeTable([], () => ({ createdAt: new Date(), undoneAt: null }));
	installed = installFakes({ bot: bots, userSettings: settings, memoryEntry: memories, memoryChange: changes });
});
afterEach(() => installed.restore());

const setConfig = (userId: string, configJson: unknown) => void settings.rows.push({ id: `s-${userId}`, userId, configJson });

test("orquestrador usa o padrão maior (6000); outros bots e o perfil user seguem o limite fixo", async () => {
	assert.equal(await memoryLimitFor("u1", "orq", "memory"), 6000);
	assert.equal(await memoryLimitFor("u1", "fin", "memory"), MEMORY_CHAR_LIMIT);
	assert.equal(await memoryLimitFor("u1", "orq", "user"), USER_CHAR_LIMIT);
	assert.equal(await memoryLimitFor("u1", undefined, "memory"), MEMORY_CHAR_LIMIT);
	// O bot principal de OUTRO usuário não vale para este.
	assert.equal(await memoryLimitFor("u1", "other-orq", "memory"), MEMORY_CHAR_LIMIT);
});

test("o limite escolhido na conta vale só para o orquestrador e fica dentro de 2200 a 20000", async () => {
	setConfig("u1", { v: 1, reflection: { memoryChars: 12000 } });
	assert.equal(await memoryLimitFor("u1", "orq", "memory"), 12000);
	assert.equal(await memoryLimitFor("u1", "fin", "memory"), MEMORY_CHAR_LIMIT);
	settings.rows.length = 0;
	setConfig("u1", { v: 1, reflection: { memoryChars: 999999 } });
	assert.equal(await memoryLimitFor("u1", "orq", "memory"), 6000, "valor inválido volta ao padrão");
});

test("add: o orquestrador aceita além de 2200; outro bot recusa no limite normal", async () => {
	const big = "x".repeat(2000);
	assert.equal((await addMemoryEntry({ userId: "u1", botId: "orq", target: "memory", content: big })).ok, true);
	const second = await addMemoryEntry({ userId: "u1", botId: "orq", target: "memory", content: `${big}y` });
	assert.equal(second.ok, true, "4001 de 6000 cabe no orquestrador");

	assert.equal((await addMemoryEntry({ userId: "u1", botId: "fin", target: "memory", content: big })).ok, true);
	const refused = await addMemoryEntry({ userId: "u1", botId: "fin", target: "memory", content: `${big}z` });
	assert.equal(refused.ok, false);
	assert.match(refused.ok ? "" : refused.error, /2200/);
});

test("o uso exibido mostra os caracteres usados e o limite em vigor de cada bot", async () => {
	await addMemoryEntry({ userId: "u1", botId: "orq", target: "memory", content: "a".repeat(3100) });
	await addMemoryEntry({ userId: "u1", botId: "fin", target: "memory", content: "b".repeat(100) });
	assert.deepEqual((await getMemorySnapshot("u1", "orq")).memory.usage, { used: 3100, limit: 6000 });
	assert.deepEqual((await getMemorySnapshot("u1", "fin")).memory.usage, { used: 100, limit: MEMORY_CHAR_LIMIT });
});

test("prompt sem pergunta: sem vencidas nem [RESOLVIDA] e limitado ao orçamento normal", () => {
	const now = new Date("2026-10-15T12:00:00Z");
	const entries = [
		entry("a", "Pendência aberta importante", { category: "pendencia", importance: 0.9 }),
		entry("b", "[RESOLVIDA 10/10] antiga", { category: "pendencia-resolvida", importance: 0.2 }),
		entry("c", "Venceu", { validUntil: "2026-10-01T00:00:00.000Z" }),
		entry("d", "Fato comum"),
	];
	const view = { entries, usage: { used: 100, limit: 6000 } };
	assert.deepEqual(promptMemoryView(view, now).entries.map((e) => e.id), ["a", "d"]);

	const many = Array.from({ length: 30 }, (_, i) => entry(`m${i}`, "z".repeat(300), { importance: i === 29 ? 1 : 0 }));
	const kept = promptMemoryView({ entries: many, usage: { used: 9000, limit: 12000 } }, now).entries;
	assert.ok(kept.reduce((sum, e) => sum + e.content.length, 0) <= BOT_CHARS_FOR_TEST);
	assert.ok(kept.some((e) => e.id === "m29"), "a mais importante fica");
	assert.deepEqual(kept.map((e) => e.id), [...kept.map((e) => e.id)].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))), "ordem original");
});
