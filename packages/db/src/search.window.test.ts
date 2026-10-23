/**
 * `searchConversationMessages` com janela de datas: o filtro entra na consulta e convive com o escopo de dono e bot.
 * Runner: `pnpm exec tsx --test src/search.window.test.ts` em packages/db.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Prisma } from "@prisma/client";

process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";
const { prisma } = await import("./client.js");
const { searchConversationMessages } = await import("./search.js");

function stubRaw() {
	const captured: Array<{ text: string; values: unknown[] }> = [];
	const raw = prisma as unknown as { $queryRaw: unknown };
	const original = raw.$queryRaw;
	raw.$queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
		const query = Prisma.sql(strings, ...values);
		captured.push({ text: query.text, values: query.values });
		return [{ conversationId: "conv-a", role: "user", content: "prazo de 45 dias", createdAt: new Date("2026-10-14T10:00:00Z") }];
	};
	return { captured, restore: () => void (raw.$queryRaw = original) };
}

test("since/until entram como filtro de data junto do dono e do bot", async () => {
	const stub = stubRaw();
	try {
		const since = new Date("2026-10-12T00:00:00Z");
		const until = new Date("2026-10-19T00:00:00Z");
		const hits = await searchConversationMessages("prazo", { userId: "user-a", botId: "bot-a", since, until });
		assert.equal(hits.length, 1);
		const query = stub.captured[0]!;
		assert.match(query.text, /cm\."createdAt" >= \$/);
		assert.match(query.text, /cm\."createdAt" < \$/);
		for (const value of ["user-a", "bot-a", since, until]) assert.ok(query.values.some((item) => (item instanceof Date && value instanceof Date ? item.getTime() === value.getTime() : item === value)));
	} finally {
		stub.restore();
	}
});

test("sem janela (ou com data inválida) a consulta não tem filtro de data", async () => {
	const stub = stubRaw();
	try {
		await searchConversationMessages("prazo", { userId: "user-a", botId: "bot-a" });
		await searchConversationMessages("prazo", { userId: "user-a", botId: "bot-a", since: new Date("x") });
		for (const query of stub.captured) assert.doesNotMatch(query.text, /"createdAt" [<>]/);
	} finally {
		stub.restore();
	}
});
