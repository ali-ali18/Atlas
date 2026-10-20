import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { Hono } from "hono";
import type { AuthEnv } from "../middleware/auth.js";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
const { prisma } = await import("@workspace/db");
const { createRunRoutes } = await import("./runs.js");

const A = "inspect-owner-a";
const B = "inspect-owner-b";
const now = new Date();
const restorers: (() => void)[] = [];
/** Prisma usa proxies: node:test mock.method não encontra o descriptor nativo. */
function stubMethod<T extends object, K extends keyof T, F extends (...args: never[]) => unknown>(object: T, key: K, fake: F) {
	const original = object[key];
	const replacement = mock.fn(fake);
	Object.defineProperty(object, key, { value: replacement, configurable: true, writable: true });
	restorers.push(() => { Object.defineProperty(object, key, { value: original, configurable: true, writable: true }); });
	return replacement;
}
afterEach(() => { for (const restore of restorers.reverse()) restore(); restorers.length = 0; });

const runRow = { id: "run-a", userId: A, conversationId: "conv-a", origin: "chat", status: "completed", model: "test/model", error: null };
const stepRows = [
	{ index: 0, decisionIndex: 0, subIndex: 0, type: "model", status: "completed", inputJson: null, tokens: 100, costUsd: 0.01, durationMs: 900, idempotencyKey: "m0", outputJson: { finishReason: "tool_calls", telemetry: { v: 1, promptTokens: 100, completionTokens: 10, cachedTokens: 60 }, inspect: { v: 1, tokens: { system: 50, tools: 20, history: 10, toolResults: 0, notes: 5, turn: 15 }, total: 100, messages: 3, tools: { count: 1, names: ["read"] }, actions: [{ kind: "collapsed", count: 2 }] } } },
	{ index: 1, decisionIndex: 0, subIndex: 1, type: "tool_result", status: "failed", inputJson: { name: "read", args: { path: "/tmp/x", token: "sk-abcdefghijklmnopqrstuvwxyz123456" } }, outputJson: { ok: false, summary: "falhou" }, tokens: null, costUsd: null, durationMs: 40, idempotencyKey: "t1" },
];

function appFor(userId: string) {
	const config: Parameters<typeof createRunRoutes>[0] = { port: 3001, hostname: "localhost", openRouterApiKey: "test-only", openRouterModel: "test/model", redisUrl: "", databaseUrl: undefined, chatQueue: null, routineQueue: null,
		agentRunQueue: { add: (async () => ({ id: "job" })) as never, getJob: async () => undefined },
	};
	const app = new Hono<AuthEnv>();
	app.use("*", async (c, next) => {
		c.set("session", { user: { id: userId, name: "Test", email: "owner@example.com", emailVerified: true, createdAt: now, updatedAt: now }, session: { id: "session", token: "test", userId, expiresAt: now, createdAt: now, updatedAt: now, ipAddress: null, userAgent: null } });
		await next();
	});
	app.route("/", createRunRoutes(config, { getAccountConfig: async () => ({ v: 1 as const }), publishRunSignal: async () => true, subscribeRunEvents: () => () => undefined }));
	return app;
}

function stubRows() {
	stubMethod(prisma.agentRun, "findFirst", async ({ where }: { where: { id: string; userId: string } }) => (where.id === "run-a" && where.userId === A ? runRow : null));
	stubMethod(prisma.agentStep, "findMany", async () => stepRows);
	stubMethod(prisma.runEvent, "findMany", async () => [
		{ seq: 1, type: "inspect_context", payload: { type: "inspect_context", transcript: { mode: "fallback", reason: "no_watermark" } }, createdAt: now },
	]);
	stubMethod(prisma.conversationMessage, "findMany", async () => [
		{ id: "m1", content: JSON.stringify({ v: 1, kind: "confirm", confirmId: "c1", title: "Enviar e-mail", status: "failed", outcome: { ok: false, detail: "sem permissão" } }) },
	]);
}

test("dono recebe os passos, as chamadas de tool e as aprovações", async () => {
	stubRows();
	const response = await appFor(A).request("/v1/runs/run-a/inspect");
	assert.equal(response.status, 200);
	const { inspection } = await response.json() as { inspection: import("@workspace/shared").RunInspection };
	assert.equal(inspection.steps.length, 1);
	assert.equal(inspection.steps[0]!.cacheReadTokens, 60);
	assert.deepEqual(inspection.steps[0]!.toolNames, ["read"]);
	assert.deepEqual(inspection.context, { mode: "fallback", reason: "no_watermark" });
	assert.equal(inspection.toolCalls[0]!.status, "failed");
	assert.equal(inspection.approvals[0]!.status, "failed");
	assert.equal(inspection.approvals[0]!.detail, "sem permissão");
	assert.ok(!JSON.stringify(inspection).includes("sk-abcdefghijklmnopqrstuvwxyz123456"), "segredo nos argumentos deve sair mascarado");
});

test("outro usuário recebe 404 e nada é lido além do run", async () => {
	stubMethod(prisma.agentRun, "findFirst", async ({ where }: { where: { id: string; userId: string } }) => (where.id === "run-a" && where.userId === A ? runRow : null));
	const steps = stubMethod(prisma.agentStep, "findMany", async () => { throw new Error("não deve ler passos"); });
	const events = stubMethod(prisma.runEvent, "findMany", async () => { throw new Error("não deve ler eventos"); });
	const cards = stubMethod(prisma.conversationMessage, "findMany", async () => { throw new Error("não deve ler cartões"); });
	const response = await appFor(B).request("/v1/runs/run-a/inspect");
	assert.equal(response.status, 404);
	assert.equal(steps.mock.callCount() + events.mock.callCount() + cards.mock.callCount(), 0);
	assert.equal((await appFor(A).request("/v1/runs/inexistente/inspect")).status, 404);
});
