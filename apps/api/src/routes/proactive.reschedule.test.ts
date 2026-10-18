import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import type { AuthEnv } from "../middleware/auth.js";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";

const { prisma } = await import("@workspace/db");
const { createProactiveRoutes } = await import("./proactive.js");

const USER_A = "user-a-ficticio";
const USER_B = "user-b-ficticio";
// Quarta 2026-10-14, 10:00 em São Paulo.
const NOW = new Date("2026-10-14T13:00:00.000Z");

type Row = Record<string, unknown> & { id: string; userId: string; botId: string; status: string; dueAt: Date };

function install(accountTz?: string) {
	const rows: Row[] = [
		{ id: "f1", userId: USER_A, botId: "bot-a", status: "pending", dueAt: new Date("2026-10-30T12:00:00.000Z"), requestedFor: NOW, note: "Entregar relatório", kind: "reminder", source: "chat", attempts: 2 },
		{ id: "f-done", userId: USER_A, botId: "bot-a", status: "done", dueAt: NOW, requestedFor: NOW, note: "x", kind: "reminder", source: "chat" },
	];
	const original = {
		botFindFirst: prisma.bot.findFirst,
		fuFindFirst: prisma.botFollowup.findFirst,
		fuUpdateMany: prisma.botFollowup.updateMany,
		settings: prisma.userSettings.findUnique,
	};
	prisma.bot.findFirst = (async (args: { where: { id: string; ownerId: string } }) =>
		args.where.id === "bot-a" && args.where.ownerId === USER_A
			? {
					id: "bot-a",
					ownerId: USER_A,
					isPrimary: true,
					conversationId: "c1",
					policyJson: { proactive: { enabled: true, timezone: "America/Sao_Paulo", quietStart: "22:00", quietEnd: "08:00", maxPerDay: 3, routineMode: "suggest" } },
					openRouterModel: null,
					name: "Bot",
				}
			: null) as unknown as typeof prisma.bot.findFirst;
	prisma.botFollowup.findFirst = (async (args: { where: { id: string; userId: string; botId: string; status: string } }) =>
		rows.find((r) => r.id === args.where.id && r.userId === args.where.userId && r.botId === args.where.botId && r.status === args.where.status) ?? null) as unknown as typeof prisma.botFollowup.findFirst;
	prisma.botFollowup.updateMany = (async (args: { where: { id: string; userId: string }; data: Record<string, unknown> }) => {
		const row = rows.find((r) => r.id === args.where.id && r.userId === args.where.userId && r.status === "pending");
		if (!row) return { count: 0 };
		Object.assign(row, args.data);
		return { count: 1 };
	}) as unknown as typeof prisma.botFollowup.updateMany;
	prisma.userSettings.findUnique = (async () =>
		accountTz ? { configJson: { v: 1, general: { timezone: accountTz } } } : null) as unknown as typeof prisma.userSettings.findUnique;
	return {
		rows,
		restore() {
			prisma.bot.findFirst = original.botFindFirst;
			prisma.botFollowup.findFirst = original.fuFindFirst;
			prisma.botFollowup.updateMany = original.fuUpdateMany;
			prisma.userSettings.findUnique = original.settings;
		},
	};
}

function appFor(userId: string) {
	const outer = new Hono<AuthEnv>();
	outer.use("*", async (c, next) => {
		c.set("session", { user: { id: userId } } as AuthEnv["Variables"]["session"]);
		await next();
	});
	outer.route("/", createProactiveRoutes(null, () => NOW));
	return outer;
}

const patch = (app: Hono<AuthEnv>, id: string, body: unknown, bot = "bot-a") =>
	app.request(`/v1/bots/${bot}/followups/${id}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});

test("reagenda no fuso do bot e zera tentativas", async () => {
	const fake = install();
	try {
		const res = await patch(appFor(USER_A), "f1", { when: "2026-10-20T09:00" });
		assert.equal(res.status, 200);
		const body = await res.json();
		assert.equal(body.followup.dueAt, "2026-10-20T12:00:00.000Z");
		assert.equal(body.movedForQuietHours, false);
		assert.equal(fake.rows[0]!.attempts, 0);
	} finally {
		fake.restore();
	}
});

test("o fuso da conta vale sobre o do bot", async () => {
	const fake = install("UTC");
	try {
		const res = await patch(appFor(USER_A), "f1", { when: "2026-10-20T09:00" });
		assert.equal((await res.json()).followup.dueAt, "2026-10-20T09:00:00.000Z");
	} finally {
		fake.restore();
	}
});

test("data no passado é recusada e nada muda", async () => {
	const fake = install();
	try {
		const before = fake.rows[0]!.dueAt;
		const res = await patch(appFor(USER_A), "f1", { when: "2026-10-10T09:00" });
		assert.equal(res.status, 400);
		assert.match((await res.json()).error, /passou/);
		assert.equal(fake.rows[0]!.dueAt, before);
	} finally {
		fake.restore();
	}
});

test("dentro do silêncio (22h-8h) vai para 08:00 e avisa", async () => {
	const fake = install();
	try {
		const res = await patch(appFor(USER_A), "f1", { when: "2026-10-20T23:30" });
		assert.equal(res.status, 200);
		const body = await res.json();
		assert.equal(body.movedForQuietHours, true);
		assert.equal(body.followup.dueAt, "2026-10-21T11:00:00.000Z");
	} finally {
		fake.restore();
	}
});

test("outro usuário, lembrete concluído ou inexistente: 404", async () => {
	const fake = install();
	try {
		assert.equal((await patch(appFor(USER_B), "f1", { when: "2026-10-20T09:00" })).status, 404);
		assert.equal((await patch(appFor(USER_A), "f-done", { when: "2026-10-20T09:00" })).status, 404);
		assert.equal((await patch(appFor(USER_A), "nope", { when: "2026-10-20T09:00" })).status, 404);
		assert.equal((await patch(appFor(USER_A), "f1", { when: "2026-10-20T09:00" }, "bot-b")).status, 404);
		assert.equal(fake.rows[0]!.dueAt.toISOString(), "2026-10-30T12:00:00.000Z");
	} finally {
		fake.restore();
	}
});

test("corpo sem when é 400", async () => {
	const fake = install();
	try {
		assert.equal((await patch(appFor(USER_A), "f1", {})).status, 400);
	} finally {
		fake.restore();
	}
});

test("lembrete com avisos: padrão move o próximo pendente; stage escolhe outro; enviado é recusado", async () => {
	const fake = install();
	try {
		fake.rows[0]!.stages = [
			{ at: "2026-10-10T12:00:00.000Z", firedAt: "2026-10-10T12:01:00.000Z" },
			{ at: "2026-10-30T12:00:00.000Z", firedAt: null },
			{ at: "2026-11-11T12:00:00.000Z", firedAt: null },
		];
		const app = appFor(USER_A);
		const first = await (await patch(app, "f1", { when: "2026-10-22T09:00" })).json();
		assert.equal(first.followup.dueAt, "2026-10-22T12:00:00.000Z");
		assert.deepEqual(first.followup.stages.map((s: { at: string }) => s.at), ["2026-10-10T12:00:00.000Z", "2026-10-22T12:00:00.000Z", "2026-11-11T12:00:00.000Z"]);
		const third = await (await patch(app, "f1", { when: "2026-11-05T09:00", stage: 3 })).json();
		assert.equal(third.followup.dueAt, "2026-10-22T12:00:00.000Z");
		assert.equal(third.followup.stages[2].at, "2026-11-05T12:00:00.000Z");
		assert.equal((await patch(app, "f1", { when: "2026-11-05T09:00", stage: 1 })).status, 400);
		assert.equal((await patch(app, "f1", { when: "2026-11-05T09:00", stage: 9 })).status, 400);
	} finally {
		fake.restore();
	}
});
