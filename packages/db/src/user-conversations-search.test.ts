/**
 * Busca nas conversas dos outros bots do usuário: isolamento por dono. Prisma stubado (tabelas falsas).
 * Runner: `pnpm exec tsx --test src/user-conversations-search.test.ts` em packages/db.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Prisma } from "@prisma/client";

process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";
const { prisma } = await import("./client.js");
const { searchOtherBotsConversations } = await import("./user-conversations-search.js");

type Message = { botId: string; botName: string; ownerId: string; conversationUserId: string | null; conversationId: string; role: string; content: string; createdAt: Date };

const TABLE: Message[] = [
	{ botId: "bot-vendas", botName: "Vendas", ownerId: "user-a", conversationUserId: "user-a", conversationId: "conv-v", role: "user", content: "o fornecedor Santa Helena atrasou a entrega", createdAt: new Date("2026-10-14T10:00:00Z") },
	{ botId: "bot-vendas", botName: "Vendas", ownerId: "user-a", conversationUserId: "user-a", conversationId: "conv-v", role: "tool", content: "Santa Helena segredo do conector", createdAt: new Date("2026-10-14T10:01:00Z") },
	{ botId: "bot-atual", botName: "Atual", ownerId: "user-a", conversationUserId: "user-a", conversationId: "conv-atual", role: "user", content: "Santa Helena aqui mesmo", createdAt: new Date("2026-10-15T10:00:00Z") },
	{ botId: "bot-b", botName: "Do usuário B", ownerId: "user-b", conversationUserId: "user-b", conversationId: "conv-b", role: "user", content: "Santa Helena do usuário B", createdAt: new Date("2026-10-14T11:00:00Z") },
	{ botId: "bot-legado", botName: "Legado", ownerId: "", conversationUserId: null, conversationId: "conv-l", role: "user", content: "Santa Helena legado sem dono", createdAt: new Date("2026-10-14T12:00:00Z") },
];

/** Interpreta o SQL montado (com os fragmentos aninhados) contra a tabela falsa, aplicando os mesmos filtros. */
function stubRaw() {
	const captured: Array<{ sql: string; values: unknown[] }> = [];
	const raw = prisma as unknown as { $queryRaw: unknown };
	const original = raw.$queryRaw;
	raw.$queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
		const query = Prisma.sql(strings, ...values);
		captured.push({ sql: query.text, values: query.values });
		const has = (value: unknown) => query.values.includes(value);
		const dates = query.values.filter((value): value is Date => value instanceof Date);
		const sinceAt = query.text.includes('>=') ? dates[0] : undefined;
		return TABLE.filter(
			(row) =>
				has(row.ownerId) &&
				(row.conversationUserId === null || has(row.conversationUserId)) &&
				["user", "assistant"].includes(row.role) &&
				!(query.text.includes('<>') && has(row.botId)) &&
				(!sinceAt || row.createdAt >= sinceAt) &&
				row.content.toLowerCase().includes("santa helena"),
		).map((row) => ({ ...row, createdAt: row.createdAt }));
	};
	return { captured, restore: () => void (raw.$queryRaw = original) };
}

test("devolve só conversas de OUTROS bots do mesmo dono, com o nome do bot, sem resultados de ferramenta", async () => {
	const stub = stubRaw();
	try {
		const hits = await searchOtherBotsConversations("Santa Helena", { userId: "user-a", excludeBotId: "bot-atual" });
		assert.deepEqual(hits.map((hit) => [hit.botName, hit.role]), [["Vendas", "user"]]);
		assert.equal(hits[0]!.createdAt, "2026-10-14T10:00:00.000Z");
		const sql = stub.captured[0]!.sql;
		assert.match(sql, /b\."ownerId" = \$/);
		assert.match(sql, /cm\."role" IN \('user', 'assistant'\)/);
		assert.ok(stub.captured[0]!.values.includes("user-a"));
		assert.ok(stub.captured[0]!.values.includes("bot-atual"));
	} finally {
		stub.restore();
	}
});

test("usuário B não enxerga conversas de A, e o legado sem dono não aparece para ninguém", async () => {
	const stub = stubRaw();
	try {
		const asB = await searchOtherBotsConversations("Santa Helena", { userId: "user-b", excludeBotId: "bot-x" });
		assert.deepEqual(asB.map((hit) => hit.botId), ["bot-b"]);
		const asA = await searchOtherBotsConversations("Santa Helena", { userId: "user-a" });
		assert.ok(!asA.some((hit) => hit.botId === "bot-b" || hit.botId === "bot-legado"));
	} finally {
		stub.restore();
	}
});

test("sem dono válido, usuário legado ou consulta vazia: não consulta o banco", async () => {
	const stub = stubRaw();
	try {
		for (const userId of ["", "  ", "default"]) assert.deepEqual(await searchOtherBotsConversations("Santa Helena", { userId }), []);
		assert.deepEqual(await searchOtherBotsConversations("   ", { userId: "user-a" }), []);
		assert.equal(stub.captured.length, 0);
	} finally {
		stub.restore();
	}
});

test("janela de datas entra na consulta e datas inválidas são ignoradas", async () => {
	const stub = stubRaw();
	try {
		const hits = await searchOtherBotsConversations("Santa Helena", { userId: "user-a", since: new Date("2026-10-15T00:00:00Z") });
		assert.deepEqual(hits.map((hit) => hit.botId), ["bot-atual"]);
		assert.match(stub.captured[0]!.sql, /cm\."createdAt" >= \$/);
		await searchOtherBotsConversations("Santa Helena", { userId: "user-a", since: new Date("nope"), until: new Date("nope") });
		assert.doesNotMatch(stub.captured[1]!.sql, /"createdAt" [<>]/);
	} finally {
		stub.restore();
	}
});

test("limite é travado entre 1 e 10", async () => {
	const stub = stubRaw();
	try {
		await searchOtherBotsConversations("Santa Helena", { userId: "user-a", limit: 500 });
		await searchOtherBotsConversations("Santa Helena", { userId: "user-a", limit: 0 });
		assert.ok(stub.captured[0]!.values.includes(10));
		assert.ok(stub.captured[1]!.values.includes(1));
	} finally {
		stub.restore();
	}
});
