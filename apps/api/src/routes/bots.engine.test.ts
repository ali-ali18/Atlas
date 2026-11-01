import assert from "node:assert/strict";
import { test } from "node:test";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";

async function appFor(userId: string) {
	const { Hono } = await import("hono");
	const { createBotRoutes } = await import("./bots.js");
	const app = new Hono();
	app.use("*", async (c, next) => {
		(c as unknown as { set: (k: string, v: unknown) => void }).set("session", { user: { id: userId } });
		await next();
	});
	app.route("/", createBotRoutes({ isKnownModel: async (id) => id === "anthropic/claude-haiku" }));
	return app;
}

const patch = (app: Awaited<ReturnType<typeof appFor>>, policyJson: unknown) =>
	app.request("/v1/bots/bot-1", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ policyJson }) });

test("PATCH /v1/bots/:id valida as chaves do motor (piloto do motor v2) e escopa por dono", async () => {
	const { prisma } = await import("@workspace/db");
	const row = (policyJson: unknown) => ({
		id: "bot-1", ownerId: "user-a", name: "Radar", snippet: "", color: "#f44336", shape: "rond",
		description: null, openRouterModel: null, language: "pt-BR", pinned: false, pinOrder: null,
		sectionId: null, memberIds: [], conversationId: null, policyJson, autonomyJson: null,
		createdAt: new Date(0), updatedAt: new Date(0),
	});
	const bot = prisma.bot as unknown as Record<string, unknown>;
	const client = prisma as unknown as Record<string, unknown>;
	const originals = { findUnique: bot.findUnique, findFirst: bot.findFirst, update: bot.update, tx: client.$transaction };
	let saved: unknown;
	client.$transaction = async (fn: (tx: unknown) => unknown) =>
		fn({ $queryRaw: async () => [{ policyJson: null }], bot: { update: (args: unknown) => (bot.update as (a: unknown) => unknown)(args), updateMany: async () => ({ count: 0 }) } });
	bot.findUnique = async () => row(null);
	bot.findFirst = async (args: { where: { ownerId: string } }) => (args.where.ownerId === "user-a" ? { id: "bot-1" } : null);
	bot.update = async (args: { data: { policyJson?: unknown } }) => {
		saved = args.data.policyJson;
		return row(args.data.policyJson);
	};
	try {
		const a = await appFor("user-a");
		for (const bad of [{ engine: "v3" }, { longWorkBudgetUsd: 100 }, { longWorkMinutes: 0 }, { helperModel: 7 }, { helperModel: "foo/nao-existe" }, { engine: "v2", engineScope: "tudo" }, { engineScope: true }, { engineScope: "ALL" }, { engineScope: 1 }]) {
			assert.equal((await patch(a, bad)).status, 400, JSON.stringify(bad));
		}
		assert.equal(saved, undefined);
		const ok = { engine: "v2", longWorkBudgetUsd: 1, longWorkMinutes: 30, helperModel: "anthropic/claude-haiku" };
		assert.equal((await patch(a, ok)).status, 200);
		assert.deepEqual(saved, ok);
		saved = undefined;
		// Escopo ampliado: "all" e "chat" passam e são gravados como vieram.
		for (const scoped of [{ engine: "v2", engineScope: "all" }, { engine: "v2", engineScope: "chat" }]) {
			assert.equal((await patch(a, scoped)).status, 200, JSON.stringify(scoped));
			assert.deepEqual(saved, scoped);
		}
		saved = undefined;
		// Outro dono: 404, nada gravado (também para o escopo novo).
		assert.equal((await patch(await appFor("user-b"), ok)).status, 404);
		assert.equal((await patch(await appFor("user-b"), { engine: "v2", engineScope: "all" })).status, 404);
		assert.equal((await patch(await appFor("user-b"), { engine: "v2", engineScope: "tudo" })).status, 404);
		assert.equal(saved, undefined);
	} finally {
		bot.findUnique = originals.findUnique;
		bot.findFirst = originals.findFirst;
		bot.update = originals.update;
		client.$transaction = originals.tx;
	}
});
