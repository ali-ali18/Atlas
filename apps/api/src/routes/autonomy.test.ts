import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Hono } from "hono";
import type { AuthEnv } from "../middleware/auth.js";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";

const { prisma, loadEffectiveAutonomy, addBotAutonomyException } = await import("@workspace/db");
const { createAutonomyRoutes } = await import("./autonomy.js");

const USER_A = "user-a-ficticio";
const USER_B = "user-b-ficticio";
const NOW = new Date("2026-09-29T12:00:00.000Z");

type Store = {
	bots: Map<string, { id: string; name: string; ownerId: string | null; autonomyJson: unknown }>;
	settings: Map<string, { userId: string; autonomyJson: unknown }>;
};

/** Prisma.DbNull (objeto sentinela) vira null no dublê. */
function plain(value: unknown): unknown {
	if (value && typeof value === "object" && Object.keys(value).length === 0) return null;
	return value;
}

/** Dublê in-memory dos delegates usados por `packages/db/src/autonomy.ts`. */
function installFakePrisma(store: Store) {
	const originals = {
		botFindFirst: prisma.bot.findFirst,
		botUpdate: prisma.bot.update,
		botUpdateMany: prisma.bot.updateMany,
		settingsFindUnique: prisma.userSettings.findUnique,
		settingsUpsert: prisma.userSettings.upsert,
		settingsUpdateMany: prisma.userSettings.updateMany,
	};
	prisma.bot.findFirst = (async (args: { where: { id: string; ownerId: { in: Array<string | null> } } }) => {
		const bot = store.bots.get(args.where.id);
		if (!bot) return null;
		return args.where.ownerId.in.includes(bot.ownerId) ? bot : null;
	}) as unknown as typeof prisma.bot.findFirst;
	prisma.bot.update = (async (args: { where: { id: string }; data: { autonomyJson: unknown } }) => {
		const bot = store.bots.get(args.where.id)!;
		bot.autonomyJson = plain(args.data.autonomyJson);
		return bot;
	}) as unknown as typeof prisma.bot.update;
	prisma.bot.updateMany = (async (args: {
		where: { id: string; autonomyJson: { equals: unknown } };
		data: { autonomyJson: unknown };
	}) => {
		const bot = store.bots.get(args.where.id);
		if (!bot || JSON.stringify(bot.autonomyJson) !== JSON.stringify(args.where.autonomyJson.equals)) {
			return { count: 0 };
		}
		bot.autonomyJson = plain(args.data.autonomyJson);
		return { count: 1 };
	}) as unknown as typeof prisma.bot.updateMany;
	prisma.userSettings.findUnique = (async (args: { where: { userId: string } }) =>
		store.settings.get(args.where.userId) ?? null) as unknown as typeof prisma.userSettings.findUnique;
	prisma.userSettings.upsert = (async (args: { where: { userId: string }; update: { autonomyJson: unknown } }) => {
		const row = store.settings.get(args.where.userId) ?? { userId: args.where.userId, autonomyJson: null };
		row.autonomyJson = plain(args.update.autonomyJson);
		store.settings.set(args.where.userId, row);
		return row;
	}) as unknown as typeof prisma.userSettings.upsert;
	prisma.userSettings.updateMany = (async (args: {
		where: { userId: string; autonomyJson: { equals: unknown } };
		data: { autonomyJson: unknown };
	}) => {
		const row = store.settings.get(args.where.userId);
		if (!row || JSON.stringify(row.autonomyJson) !== JSON.stringify(args.where.autonomyJson.equals)) {
			return { count: 0 };
		}
		row.autonomyJson = plain(args.data.autonomyJson);
		return { count: 1 };
	}) as unknown as typeof prisma.userSettings.updateMany;
	return () => {
		prisma.bot.findFirst = originals.botFindFirst;
		prisma.bot.update = originals.botUpdate;
		prisma.bot.updateMany = originals.botUpdateMany;
		prisma.userSettings.findUnique = originals.settingsFindUnique;
		prisma.userSettings.upsert = originals.settingsUpsert;
		prisma.userSettings.updateMany = originals.settingsUpdateMany;
	};
}

function appFor(userId: string) {
	const outer = new Hono<AuthEnv>();
	outer.use("*", async (c, next) => {
		c.set("session", { user: { id: userId } } as AuthEnv["Variables"]["session"]);
		await next();
	});
	outer.route("/", createAutonomyRoutes(() => NOW));
	return outer;
}

const put = (app: Hono<AuthEnv>, path: string, body: unknown) =>
	app.request(path, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});

function freshStore(): Store {
	return {
		bots: new Map([["bot-a", { id: "bot-a", name: "Taldo", ownerId: USER_A, autonomyJson: null }]]),
		settings: new Map(),
	};
}

test("conta: padrão Equilibrado, grava nível com validade e devolve o efetivo", async () => {
	const restore = installFakePrisma(freshStore());
	try {
		const app = appFor(USER_A);
		const initial = await (await app.request("/v1/autonomy")).json();
		assert.equal(initial.effective.level, "balanced");
		assert.equal(initial.source, "default");
		const res = await put(app, "/v1/autonomy", { level: "autonomous", duration: "7d" });
		assert.equal(res.status, 200);
		const view = await res.json();
		assert.equal(view.effective.level, "autonomous");
		assert.equal(view.effective.until, "2026-10-06T12:00:00.000Z");
		assert.equal(view.stored.fallbackLevel, "balanced");
	} finally {
		restore();
	}
});

test("body inválido devolve 400", async () => {
	const restore = installFakePrisma(freshStore());
	try {
		const res = await put(appFor(USER_A), "/v1/autonomy", { level: "turbo" });
		assert.equal(res.status, 400);
	} finally {
		restore();
	}
});

test("bot: override próprio e herdar (level null) voltam à conta", async () => {
	const store = freshStore();
	const restore = installFakePrisma(store);
	try {
		const app = appFor(USER_A);
		await put(app, "/v1/autonomy", { level: "always_ask" });
		const own = await (await put(app, "/v1/bots/bot-a/autonomy", { level: "autonomous" })).json();
		assert.equal(own.effective.level, "autonomous");
		assert.equal(own.source, "bot");
		const inherit = await (await put(app, "/v1/bots/bot-a/autonomy", { level: null })).json();
		assert.equal(inherit.effective.level, "always_ask");
		assert.equal(inherit.stored, null);
		assert.equal(store.bots.get("bot-a")!.autonomyJson, null);
	} finally {
		restore();
	}
});

test("IDOR: usuário B recebe 404 ao ler ou alterar autonomia do bot de A", async () => {
	const store = freshStore();
	store.bots.get("bot-a")!.autonomyJson = { level: "autonomous", exceptions: [] };
	const restore = installFakePrisma(store);
	try {
		const app = appFor(USER_B);
		assert.equal((await app.request("/v1/bots/bot-a/autonomy")).status, 404);
		assert.equal((await put(app, "/v1/bots/bot-a/autonomy", { level: "always_ask" })).status, 404);
		assert.deepEqual(store.bots.get("bot-a")!.autonomyJson, { level: "autonomous", exceptions: [] });
		const ok = await appFor(USER_A).request("/v1/bots/bot-a/autonomy");
		assert.equal(ok.status, 200);
	} finally {
		restore();
	}
});

test("a conta de B nunca lê a política de A", async () => {
	const store = freshStore();
	store.settings.set(USER_A, { userId: USER_A, autonomyJson: { level: "autonomous", exceptions: [] } });
	const restore = installFakePrisma(store);
	try {
		const view = await (await appFor(USER_B).request("/v1/autonomy")).json();
		assert.equal(view.effective.level, "balanced");
	} finally {
		restore();
	}
});

test("vencimento: grava o fallback uma vez só (compare-and-set)", async () => {
	const store = freshStore();
	store.bots.get("bot-a")!.autonomyJson = {
		level: "autonomous",
		until: "2026-09-29T11:00:00.000Z",
		fallbackLevel: "balanced",
		exceptions: [],
	};
	const restore = installFakePrisma(store);
	try {
		const first = await loadEffectiveAutonomy({ userId: USER_A, botId: "bot-a", now: NOW });
		assert.equal(first.policy.level, "balanced");
		assert.equal(first.applied.length, 1);
		assert.equal(first.applied[0]!.to, "balanced");
		assert.deepEqual(store.bots.get("bot-a")!.autonomyJson, { exceptions: [], level: "balanced" });
		const second = await loadEffectiveAutonomy({ userId: USER_A, botId: "bot-a", now: NOW });
		assert.equal(second.applied.length, 0);
		assert.equal(second.policy.level, "balanced");
	} finally {
		restore();
	}
});

test("addBotAutonomyException cria a política herdando o nível e recusa bot de outro dono", async () => {
	const store = freshStore();
	const restore = installFakePrisma(store);
	try {
		const exception = { tool: "mcp__gmail__create_draft", mode: "never_ask" as const };
		assert.equal(await addBotAutonomyException({ botId: "bot-a", userId: USER_B, exception }), false);
		assert.equal(store.bots.get("bot-a")!.autonomyJson, null);
		assert.equal(await addBotAutonomyException({ botId: "bot-a", userId: USER_A, exception }), true);
		assert.deepEqual(store.bots.get("bot-a")!.autonomyJson, { exceptions: [exception] });
	} finally {
		restore();
	}
});

test("migração: confirmWrites=false vira exceção never_ask do conector", () => {
	const sql = readFileSync(
		new URL("../../../../packages/db/prisma/migrations/20260929010000_autonomy/migration.sql", import.meta.url),
		"utf8",
	);
	assert.match(sql, /ADD COLUMN "autonomyJson" JSONB/);
	assert.match(sql, /WHERE "confirmWrites" = false/);
	assert.match(sql, /COALESCE\("catalogId", "slug"\)/);
	assert.match(sql, /'mode', 'never_ask'/);
	assert.match(sql, /"autonomyJson" IS NULL/);
});
