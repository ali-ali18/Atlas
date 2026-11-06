/**
 * Memória do v4 no worker, com um db falso que filtra por dono como o real.
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/v4-adapters/memory.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createV4Memory, type V4MemoryDeps } from "./memory.js";

type Row = { id: string; userId: string; botId: string | null; target: "user" | "memory"; content: string; category?: string; updatedAt: Date };

function fakeDb() {
	const rows: Row[] = [];
	let seq = 0;
	const entry = (row: Row) => ({ id: row.id, target: row.target, content: row.content, category: row.category ?? null, createdAt: row.updatedAt.toISOString(), updatedAt: row.updatedAt.toISOString() });
	const deps: V4MemoryDeps = {
		// Como o db real (`readUserIds`): o dono enxerga as próprias linhas E as legadas `default`.
		snapshot: (async (userId: string, botId?: string) => ({
			user: { entries: rows.filter((r) => [userId, "default"].includes(r.userId) && r.target === "user").map(entry), usage: { used: 0, limit: 1 } },
			memory: { entries: rows.filter((r) => [userId, "default"].includes(r.userId) && r.target === "memory" && r.botId === (botId ?? null)).map(entry), usage: { used: 0, limit: 1 } },
		})) as unknown as V4MemoryDeps["snapshot"],
		add: (async (input: { userId: string; botId?: string; target: "user" | "memory"; content: string; category?: string }) => {
			if (input.content === "dup") return { ok: false, error: "duplicado", currentEntries: [], usage: "1/2 chars" };
			const row: Row = { id: `m${++seq}`, userId: input.userId, botId: input.target === "memory" ? (input.botId ?? null) : null, target: input.target, content: input.content, category: input.category, updatedAt: new Date("2026-11-06T10:00:00Z") };
			rows.push(row);
			return { ok: true, entry: entry(row) };
		}) as unknown as V4MemoryDeps["add"],
		getById: async (userId, id) => rows.find((r) => r.id === id && [userId, "default"].includes(r.userId)) ?? null,
		replaceById: (async (input: { userId: string; entryId: string; content: string }) => {
			const row = rows.find((r) => r.id === input.entryId && [input.userId, "default"].includes(r.userId));
			if (!row) return null;
			row.content = input.content;
			return { ok: true, entry: entry(row) };
		}) as unknown as V4MemoryDeps["replaceById"],
		removeById: (async (input: { userId: string; entryId: string }) => {
			const index = rows.findIndex((r) => r.id === input.entryId && [input.userId, "default"].includes(r.userId));
			if (index < 0) return null;
			const [row] = rows.splice(index, 1);
			return { ok: true, entry: entry(row as Row) };
		}) as unknown as V4MemoryDeps["removeById"],
	};
	return { deps, rows };
}

test("adiciona nas duas camadas e lista cada uma (a do bot só com o bot do run)", async () => {
	const { deps } = fakeDb();
	const memory = createV4Memory({ botId: "bot-1", deps });
	const owner = await memory.add("user-a", { layer: "owner", content: "Prefere respostas curtas", category: "preferencia" });
	const bot = await memory.add("user-a", { layer: "bot", content: "Projeto Atlas" });
	assert.equal(owner.layer, "owner");
	assert.equal(owner.category, "preferencia");
	assert.equal(bot.layer, "bot");
	assert.deepEqual((await memory.list("user-a")).map((i) => i.content), ["Prefere respostas curtas", "Projeto Atlas"]);
	assert.deepEqual((await memory.list("user-a", "owner")).map((i) => i.layer), ["owner"]);
	assert.deepEqual((await memory.list("user-a", "bot")).map((i) => i.layer), ["bot"]);
});

test("troca e apaga a entrada do dono", async () => {
	const { deps, rows } = fakeDb();
	const memory = createV4Memory({ botId: "bot-1", deps });
	const item = await memory.add("user-a", { layer: "bot", content: "velho" });
	assert.equal((await memory.replace("user-a", item.id, "novo"))?.content, "novo");
	assert.equal(await memory.remove("user-a", item.id), true);
	assert.equal(rows.length, 0);
});

test("IDOR: usuário B não lista, troca nem apaga a memória do A", async () => {
	const { deps, rows } = fakeDb();
	const a = createV4Memory({ botId: "bot-1", deps });
	const b = createV4Memory({ botId: "bot-1", deps });
	const item = await a.add("user-a", { layer: "owner", content: "segredo do A" });
	assert.deepEqual(await b.list("user-b"), []);
	assert.equal(await b.replace("user-b", item.id, "hackeado"), null);
	assert.equal(await b.remove("user-b", item.id), false);
	assert.equal(rows[0]?.content, "segredo do A");
});

test("escopo por bot: outro bot do mesmo dono não alcança a camada do bot", async () => {
	const { deps, rows } = fakeDb();
	const bot1 = createV4Memory({ botId: "bot-1", deps });
	const bot2 = createV4Memory({ botId: "bot-2", deps });
	const item = await bot1.add("user-a", { layer: "bot", content: "só do bot 1" });
	const shared = await bot1.add("user-a", { layer: "owner", content: "vale para todos" });
	assert.deepEqual((await bot2.list("user-a")).map((i) => i.content), ["vale para todos"]);
	assert.equal(await bot2.replace("user-a", item.id, "x"), null);
	assert.equal(await bot2.remove("user-a", item.id), false);
	assert.equal((await bot2.replace("user-a", shared.id, "ajustado"))?.content, "ajustado");
	assert.equal(rows.find((r) => r.id === item.id)?.content, "só do bot 1");
});

test("sem bot no run: camada do bot falha com o motivo; a do dono funciona", async () => {
	const { deps } = fakeDb();
	const memory = createV4Memory({ deps });
	await assert.rejects(memory.add("user-a", { layer: "bot", content: "x" }), /no bot/);
	assert.equal((await memory.add("user-a", { layer: "owner", content: "ok" })).layer, "owner");
});

test("falha do db (duplicado, limite) vira erro com o motivo real", async () => {
	const { deps } = fakeDb();
	await assert.rejects(createV4Memory({ botId: "bot-1", deps }).add("user-a", { layer: "owner", content: "dup" }), /duplicado/);
});

test("IDOR: linha legada `default` não é listada, trocada nem apagada por outro usuário (auditoria F2, S3)", async () => {
	const { deps, rows } = fakeDb();
	rows.push({ id: "legacy", userId: "default", botId: null, target: "user", content: "legado", updatedAt: new Date("2026-11-06T10:00:00Z") });
	const memory = createV4Memory({ botId: "bot-1", deps });
	assert.deepEqual(await memory.list("user-a"), []);
	assert.equal(await memory.replace("user-a", "legacy", "hackeado"), null);
	assert.equal(await memory.remove("user-a", "legacy"), false);
	assert.equal(rows[0]?.content, "legado");
	// O próprio dono legado (userId "default") continua alcançando a sua linha.
	assert.deepEqual((await memory.list("default")).map((i) => i.content), ["legado"]);
	assert.equal(await memory.remove("default", "legacy"), true);
});
