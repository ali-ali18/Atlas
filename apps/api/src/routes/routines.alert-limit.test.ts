import assert from "node:assert/strict";
import { test } from "node:test";
process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";

type AuthEnv = import("../middleware/auth.js").AuthEnv;

async function appFor(userId: string) {
	const { Hono } = await import("hono");
	const { createRoutineRoutes } = await import("./routines.js");
	const app = new Hono<AuthEnv>();
	app.use("*", async (c, next) => {
		c.set("session", { user: { id: userId } } as AuthEnv["Variables"]["session"]);
		await next();
	});
	app.route("/", createRoutineRoutes(null));
	return app;
}

const pausedAlert = (userId: string) => ({
	id: "r1", userId, botId: "bot-a", conversationId: null, groupId: null, pageId: null, template: null, name: "Tênis", prompt: "x", model: "m", allowChatgptPlan: false,
	enabled: false, triggerType: "interval", schedule: null, timezone: "America/Sao_Paulo", triggerJson: { kind: "interval", everyMinutes: 120 }, notify: "always", createdBy: "bot",
	lastRunAt: null, createdAt: new Date(0), updatedAt: new Date(0), alertJson: { condition: "o tênis baixar de R$ 400", active: false },
});

test("religar um alerta com 30 já ativos responde 409 com a mensagem amigável; o alerta de outro usuário não é tocado", async () => {
	const { prisma } = await import("@workspace/db");
	const originals = { findFirst: prisma.routine.findFirst, count: prisma.routine.count, update: prisma.routine.update, runFind: prisma.routineRun.findFirst };
	let countWhere: { userId?: { in: string[] } } | undefined;
	let wrote = false;
	Reflect.set(prisma.routine, "findFirst", async ({ where }: { where: unknown }) => (JSON.stringify(where).includes("user-a") ? pausedAlert("user-a") : null));
	Reflect.set(prisma.routine, "count", async ({ where }: { where: { userId: { in: string[] } } }) => {
		countWhere = where;
		return 30;
	});
	Reflect.set(prisma.routine, "update", async () => {
		wrote = true;
		return pausedAlert("user-a");
	});
	Reflect.set(prisma.routineRun, "findFirst", async () => null);
	try {
		const request = (userId: string) =>
			appFor(userId).then((app) => app.request("/v1/bots/bot-a/routines/r1", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true }) }));
		const own = await request("user-a");
		assert.equal(own.status, 409);
		assert.match(((await own.json()) as { error: string }).error, /30 alertas ativos/);
		assert.deepEqual(countWhere?.userId, { in: ["user-a"] });
		assert.equal(wrote, false);
		assert.equal((await request("user-b")).status, 404, "recurso de outro dono é 404");
	} finally {
		prisma.routine.findFirst = originals.findFirst;
		prisma.routine.count = originals.count;
		prisma.routine.update = originals.update;
		prisma.routineRun.findFirst = originals.runFind;
	}
});
