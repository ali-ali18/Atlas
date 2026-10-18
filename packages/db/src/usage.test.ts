import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { prisma } from "./client.js";
import { getUsage } from "./usage.js";

const restores: Array<() => void> = [];
function stub(target: object, key: string, value: unknown) {
	const old = Reflect.get(target, key);
	Reflect.set(target, key, value);
	restores.push(() => Reflect.set(target, key, old));
}
afterEach(() => {
	for (const restore of restores.splice(0).reverse()) restore();
});

const from = new Date("2026-10-01T00:00:00Z");
const to = new Date("2026-10-08T00:00:00Z");

type Raw = {
	botId: string | null;
	model: string;
	runs: number;
	cost: number | null;
	unknownCalls: number;
	planCalls: number;
	promptTokens: number;
	completionTokens: number;
	cachedTokens: number;
};
const raw = (over: Partial<Raw>): Raw => ({
	botId: "b1",
	model: "m1",
	runs: 1,
	cost: 0.1,
	unknownCalls: 0,
	planCalls: 0,
	promptTokens: 10,
	completionTokens: 5,
	cachedTokens: 0,
	...over,
});

/** Dublê do `$queryRaw` (template tag) e do `bot.findMany`; guarda o que foi pedido. */
function fakeDb(rows: Raw[], bots: Array<{ id: string; ownerId: string; name: string }>) {
	const seen = { sql: "", values: [] as unknown[], botWhere: [] as unknown[] };
	stub(prisma, "$queryRaw", async (strings: TemplateStringsArray, ...values: unknown[]) => {
		seen.sql = strings.join("?").replace(/[ \t\n]+/g, " ");
		seen.values = values;
		const [userId] = values as [string];
		// o dublê só devolve as linhas do dono pedido (o banco filtra por "userId")
		return rows.filter((row) => (row as Raw & { owner?: string }).owner === undefined || (row as Raw & { owner?: string }).owner === userId);
	});
	stub(prisma.bot, "findMany", async (args: { where: { id: { in: string[] }; ownerId: string } }) => {
		seen.botWhere.push(args.where);
		return bots.filter((bot) => args.where.id.in.includes(bot.id) && bot.ownerId === args.where.ownerId);
	});
	return seen;
}

test("getUsage: consulta parametrizada, escopada pelo dono, só runs raiz e com usage", async () => {
	const seen = fakeDb([], []);
	await getUsage({ userId: "user-a", from, to });
	assert.deepEqual(seen.values, ["user-a", from, to], "userId e intervalo vão como parâmetros, não no texto");
	assert.match(seen.sql, /WHERE "userId" = \?/);
	assert.match(seen.sql, /"parentRunId" IS NULL/);
	assert.match(seen.sql, /"usageJson" IS NOT NULL/);
	assert.match(seen.sql, /"createdAt" >= \? +AND "createdAt" < \?/);
	assert.doesNotMatch(seen.sql, /user-a/);
});

test("getUsage: vazio devolve zeros e custo ausente", async () => {
	fakeDb([], []);
	const out = await getUsage({ userId: "user-a", from, to });
	assert.equal(out.totals.runs, 0);
	assert.equal(out.totals.costUsd, null);
	assert.deepEqual(out.byBot, []);
	assert.deepEqual(out.byModel, []);
});

test("getUsage: por bot e por modelo, custo parcial e chamadas de plano", async () => {
	fakeDb(
		[
			raw({ botId: "b1", model: "m1", runs: 2, cost: 0.5, unknownCalls: 2 }),
			raw({ botId: "b1", model: "chatgpt/x", runs: 1, cost: null, planCalls: 3 }),
			raw({ botId: "b2", model: "m1", runs: 1, cost: 0.25 }),
			raw({ botId: null, model: "m2", runs: 1, cost: 0.1 }),
			raw({ botId: "apagado", model: "m2", runs: 1, cost: 0.05 }),
		],
		[
			{ id: "b1", ownerId: "user-a", name: "Ana" },
			{ id: "b2", ownerId: "user-a", name: "Bia" },
		],
	);
	const out = await getUsage({ userId: "user-a", from, to });
	assert.equal(out.totals.runs, 6);
	assert.ok(Math.abs((out.totals.costUsd ?? 0) - 0.9) < 1e-9);
	assert.equal(out.totals.costUnknownCalls, 2);
	assert.equal(out.totals.planCalls, 3);
	assert.deepEqual(
		out.byBot.map((row) => row.name),
		["Ana", "Bia", "Sem bot", "Bot removido"],
	);
	const plan = out.byModel.find((row) => row.model === "chatgpt/x");
	assert.equal(plan?.costUsd, null, "modelo só de plano não vira US$ 0");
	assert.equal(plan?.planCalls, 3);
	assert.equal(out.byModel.find((row) => row.model === "m1")?.runs, 3);
});

test("getUsage: nome do bot só de bots do próprio usuário (bot de B aparece como removido para A)", async () => {
	const seen = fakeDb(
		[raw({ botId: "b-de-b" })],
		[{ id: "b-de-b", ownerId: "user-b", name: "Segredo do B" }],
	);
	const out = await getUsage({ userId: "user-a", from, to });
	assert.deepEqual(seen.botWhere, [{ id: { in: ["b-de-b"] }, ownerId: "user-a" }]);
	assert.equal(out.byBot[0]?.name, "Bot removido");
	assert.doesNotMatch(JSON.stringify(out), /Segredo do B/);
});

test("getUsage: usuário B não recebe linhas de A (filtro por userId vai à consulta)", async () => {
	const seen = fakeDb([{ ...raw({ botId: "b1" }), owner: "user-a" } as Raw], [{ id: "b1", ownerId: "user-a", name: "Ana" }]);
	const forB = await getUsage({ userId: "user-b", from, to });
	assert.equal(seen.values[0], "user-b");
	assert.equal(forB.totals.runs, 0);
	const forA = await getUsage({ userId: "user-a", from, to });
	assert.equal(forA.totals.runs, 1);
});
