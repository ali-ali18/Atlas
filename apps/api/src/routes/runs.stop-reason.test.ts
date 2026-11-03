/**
 * `stopReason`/`stopDetail` no `GET /v1/runs/:id` e o motivo da parada no inspetor, com escopo por dono (usuário B não vê o run do A).
 * Sem banco real: delegates do prisma substituídos (mesma técnica de `runs-inspect.test.ts`).
 */
import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { Hono } from "hono";
import type { AuthEnv } from "../middleware/auth.js";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
const { prisma } = await import("@workspace/db");
const { createRunRoutes } = await import("./runs.js");

const A = "stop-owner-a";
const B = "stop-owner-b";
const now = new Date();
const restorers: (() => void)[] = [];
function stubMethod<T extends object, K extends keyof T, F extends (...args: never[]) => unknown>(object: T, key: K, fake: F) {
	const original = object[key];
	const replacement = mock.fn(fake);
	Object.defineProperty(object, key, { value: replacement, configurable: true, writable: true });
	restorers.push(() => { Object.defineProperty(object, key, { value: original, configurable: true, writable: true }); });
	return replacement;
}
afterEach(() => { for (const restore of restorers.reverse()) restore(); restorers.length = 0; });

const runRow = {
	id: "run-a", userId: A, botId: null, conversationId: "conv-a", origin: "chat", objective: "tarefa", status: "completed", model: "test/model", maxSteps: 200,
	sandboxSessionId: null, error: null, resultText: "ok", cancelRequested: false,
	budgetJson: { engine: "v2", caps: { costUsd: 0.25, costSource: "server" } }, usageJson: null,
	stopReason: "budget_cost", stopDetail: "delivered",
	createdAt: now, updatedAt: now, startedAt: now, finishedAt: now,
};

function appFor(userId: string) {
	const config: Parameters<typeof createRunRoutes>[0] = { port: 3001, hostname: "localhost", openRouterApiKey: "test-only", openRouterModel: "test/model", redisUrl: "", databaseUrl: "", agentRunQueue: { add: (async () => ({ id: "job" })) as never, getJob: async () => undefined } } as never;
	const app = new Hono<AuthEnv>();
	app.use("*", async (c, next) => {
		c.set("session", { user: { id: userId, name: "Test", email: "owner@example.com", emailVerified: true, createdAt: now, updatedAt: now }, session: { id: "session", token: "t", userId, expiresAt: new Date(Date.now() + 60_000), createdAt: now, updatedAt: now } } as never);
		await next();
	});
	app.route("/", createRunRoutes(config, { getAccountConfig: async () => ({ v: 1 as const }), publishRunSignal: async () => true, subscribeRunEvents: () => () => undefined } as never));
	return app;
}

const findFirst = () => stubMethod(prisma.agentRun, "findFirst", async ({ where }: { where: { id: string; userId: string } }) => (where.id === "run-a" && where.userId === A ? runRow : null));

test("GET /v1/runs/:id devolve stopReason e stopDetail ao dono", async () => {
	findFirst();
	const response = await appFor(A).request("/v1/runs/run-a");
	assert.equal(response.status, 200);
	const { run } = (await response.json()) as { run: { id: string; stopReason: string | null; stopDetail: string | null } };
	assert.equal(run.id, "run-a");
	assert.equal(run.stopReason, "budget_cost");
	assert.equal(run.stopDetail, "delivered");
});

test("escopo: o usuário B recebe 404 no run do A e nenhum motivo vaza", async () => {
	findFirst();
	const response = await appFor(B).request("/v1/runs/run-a");
	assert.equal(response.status, 404);
	assert.doesNotMatch(await response.text(), /budget_cost|stopReason|delivered/);
	assert.equal((await appFor(A).request("/v1/runs/inexistente")).status, 404);
});

test("o inspetor do dono traz o 'Motivo da parada' com valor e origem do teto; o de outro usuário é 404", async () => {
	stubMethod(prisma.agentRun, "findFirst", async ({ where }: { where: { id: string; userId: string } }) => (where.id === "run-a" && where.userId === A ? runRow : null));
	stubMethod(prisma.agentStep, "findMany", async () => []);
	stubMethod(prisma.runEvent, "findMany", async () => []);
	stubMethod(prisma.conversationMessage, "findMany", async () => []);
	const ok = await appFor(A).request("/v1/runs/run-a/inspect");
	assert.equal(ok.status, 200);
	const { inspection } = (await ok.json()) as { inspection: { stop?: { reason: string; label: string } } };
	assert.equal(inspection.stop?.reason, "budget_cost");
	assert.equal(inspection.stop?.label, "Teto de gasto configurado (US$ 0,25 · servidor)");
	assert.equal((await appFor(B).request("/v1/runs/run-a/inspect")).status, 404);
});
