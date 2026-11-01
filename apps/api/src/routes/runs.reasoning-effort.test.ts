import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { Hono } from "hono";
import type { AuthEnv } from "../middleware/auth.js";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-reasoning-runs";
const { prisma } = await import("@workspace/db");
const { createRunRoutes } = await import("./runs.js");
const now = new Date("2026-10-04T12:00:00Z");
const restorers: Array<() => void> = [];
function stub(object: object, key: string, value: (...args: never[]) => unknown) {
	const original = Object.getOwnPropertyDescriptor(object, key);
	Object.defineProperty(object, key, { value, configurable: true, writable: true });
	restorers.push(() => {
		if (original) Object.defineProperty(object, key, original);
		else Reflect.deleteProperty(object, key);
	});
}
afterEach(() => {
	for (const restore of restorers.reverse()) restore();
	restorers.length = 0;
});

function fixture() {
	const created: Array<{ budgetJson?: Record<string, unknown> | null }> = [];
	stub(prisma.agentRun, "create", async ({ data }: { data: { userId: string; model: string; budgetJson?: Record<string, unknown> | null } }) => {
		created.push(data);
		return {
			...data, id: "run-a", botId: null, conversationId: null, origin: "chat", objective: "teste", status: "queued", maxSteps: 10,
			sandboxSessionId: null, error: null, resultText: null, cancelRequested: false, usageJson: null, createdAt: now, updatedAt: now,
			startedAt: null, finishedAt: null,
		};
	});
	stub(prisma.agentRun, "update", async () => ({}));
	stub(prisma.conversationMessage, "findMany", async () => []);
	const config: Parameters<typeof createRunRoutes>[0] = {
		port: 3001, hostname: "localhost", openRouterApiKey: "k", openRouterModel: "test/model", redisUrl: "", databaseUrl: undefined,
		chatQueue: null, routineQueue: null,
		agentRunQueue: { add: async () => ({ id: "job" }), getJob: async () => undefined },
	};
	const app = new Hono<AuthEnv>();
	app.use("*", async (c, next) => {
		c.set("session", {
			user: { id: "a", name: "A", email: "owner@example.com", emailVerified: true, createdAt: now, updatedAt: now },
			session: { id: "s", token: "t", userId: "a", expiresAt: now, createdAt: now, updatedAt: now, ipAddress: null, userAgent: null },
		});
		await next();
	});
	app.route("/", createRunRoutes(config, { validateModel: async () => ({}), subscribeRunEvents: () => () => undefined }));
	return { app, created };
}
const send = (app: ReturnType<typeof fixture>["app"], extra: Record<string, unknown>) =>
	app.request("/v1/runs", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ messages: [{ role: "user", content: "oi" }], model: "anthropic/claude-sonnet-5.5", ...extra }),
	});

test("POST /v1/runs grava o nível do chat no run (a retomada mantém)", async () => {
	const { app, created } = fixture();
	for (const level of ["off", "low", "medium", "high"]) {
		const response = await send(app, { reasoningEffort: level });
		assert.equal(response.status, 202, level);
	}
	assert.deepEqual(created.map((data) => data.budgetJson?.reasoningEffort), ["off", "low", "medium", "high"]);
});

test("sem nível (ou nulo) o run herda: nada é gravado", async () => {
	const { app, created } = fixture();
	assert.equal((await send(app, {})).status, 202);
	assert.equal((await send(app, { reasoningEffort: null })).status, 202);
	assert.ok(created.every((data) => !data.budgetJson || !("reasoningEffort" in data.budgetJson)));
});

test("nível inválido é 400 e não cria run", async () => {
	const { app, created } = fixture();
	for (const bad of ["extreme", "", "LOW", 3, true]) {
		assert.equal((await send(app, { reasoningEffort: bad })).status, 400, String(bad));
	}
	assert.equal(created.length, 0);
});
