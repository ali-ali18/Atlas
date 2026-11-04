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

const routineOf = (userId: string, limitsJson: unknown) => ({
	id: "r1", userId, botId: "bot-a", conversationId: null, groupId: null, pageId: null, template: null, name: "Relatório", prompt: "x", model: "m", allowChatgptPlan: false,
	enabled: true, triggerType: "cron", schedule: "0 9 * * *", timezone: "America/Sao_Paulo", triggerJson: null, notify: "always", createdBy: "user",
	lastRunAt: null, createdAt: new Date(0), updatedAt: new Date(0), alertJson: null, limitsJson,
});

async function withStubs(fn: (state: { writes: Array<Record<string, unknown>> }) => Promise<void>) {
	const { prisma } = await import("@workspace/db");
	const originals = { findFirst: prisma.routine.findFirst, update: prisma.routine.update, runFind: prisma.routineRun.findFirst };
	const state = { writes: [] as Array<Record<string, unknown>>, stored: { maxSteps: 60 } as unknown };
	Reflect.set(prisma.routine, "findFirst", async ({ where }: { where: unknown }) => (JSON.stringify(where).includes("user-a") ? routineOf("user-a", state.stored) : null));
	Reflect.set(prisma.routine, "update", async ({ data }: { data: Record<string, unknown> }) => {
		state.writes.push(data);
		if ("limitsJson" in data) state.stored = data.limitsJson;
		return routineOf("user-a", state.stored);
	});
	Reflect.set(prisma.routineRun, "findFirst", async () => null);
	const tx = { $transaction: prisma.$transaction, $executeRaw: prisma.$executeRaw };
	Object.assign(prisma, { $transaction: async (run: (db: unknown) => Promise<unknown>) => run(prisma), $executeRaw: async () => 1 });
	try {
		await fn(state);
	} finally {
		Object.assign(prisma, tx);
		prisma.routine.findFirst = originals.findFirst;
		prisma.routine.update = originals.update;
		prisma.routineRun.findFirst = originals.runFind;
	}
}

const patch = (userId: string, body: unknown) =>
	appFor(userId).then((app) => app.request("/v1/bots/bot-a/routines/r1", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

test("limites da rotina pela API: o dono troca passos e US$ e a resposta mostra o resultado", async () => {
	await withStubs(async (state) => {
		const response = await patch("user-a", { limits: { maxSteps: 80, maxCostUsd: 0.5 } });
		assert.equal(response.status, 200);
		const body = (await response.json()) as { routine: { limits?: unknown } };
		assert.deepEqual(body.routine.limits, { maxSteps: 80, maxCostUsd: 0.5 });
		assert.deepEqual(state.writes.at(-1)?.limitsJson, { maxSteps: 80, maxCostUsd: 0.5 });
		// Patch parcial mantém o outro campo; null remove só aquele.
		const cleared = await patch("user-a", { limits: { maxCostUsd: null } });
		assert.deepEqual(((await cleared.json()) as { routine: { limits?: unknown } }).routine.limits, { maxSteps: 80 });
	});
});

test("limites da rotina pela API: fora da faixa ou campo desconhecido é 400 e não grava", async () => {
	await withStubs(async (state) => {
		const tooMany = await patch("user-a", { limits: { maxSteps: 500 } });
		assert.equal(tooMany.status, 400);
		assert.match(((await tooMany.json()) as { error: string }).error, /faixa/);
		const unknown = await patch("user-a", { limits: { maxMinutes: 10 } });
		assert.equal(unknown.status, 400);
		assert.match(((await unknown.json()) as { error: string }).error, /Aceitos: maxSteps, maxCostUsd/);
		assert.equal(state.writes.length, 0);
	});
});

test("limites da rotina pela API: outro usuário recebe 404 e nada é gravado", async () => {
	await withStubs(async (state) => {
		const response = await patch("user-b", { limits: { maxSteps: 120 } });
		assert.equal(response.status, 404);
		assert.equal(state.writes.length, 0);
	});
});
