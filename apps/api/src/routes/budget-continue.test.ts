/**
 * POST /v1/cards/budget-continue/resolve: aprovar cria o run de continuação com o orçamento GRAVADO no card e o
 * enfileira; dispensar não gasta nada; outro usuário recebe 404. Prisma em memória.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { Hono } from "hono";
import type { AuthEnv } from "../middleware/auth.js";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";

const { FakeTable, installFakes } = await import("@workspace/db/testing");
const { prisma, resolveBudgetContinue } = await import("@workspace/db");
const { createBudgetContinueRoutes } = await import("./budget-continue.js");

const USER_A = "user-a-ficticio";
const USER_B = "user-b-ficticio";

let messages: InstanceType<typeof FakeTable>;
let runs: InstanceType<typeof FakeTable>;
let installed: { restore: () => void };
let originalConversation: unknown;
const created: Array<Record<string, unknown>> = [];
const enqueued: string[] = [];

beforeEach(() => {
	created.length = 0;
	enqueued.length = 0;
	messages = new FakeTable([], () => ({ createdAt: new Date() }));
	runs = new FakeTable([{ id: "run-1", userId: USER_A, conversationId: "conv-1", botId: null, model: "m/x", status: "budget_exhausted", objective: "Pesquise tudo", budgetJson: {}, checkpointJson: { messages: [] } }]);
	installed = installFakes({ conversationMessage: messages, agentRun: runs });
	const client = prisma as unknown as Record<string, unknown>;
	originalConversation = client.conversation;
	client.conversation = {
		findFirst: async ({ where }: { where: { id: string; userId: string } }) => (where.id === "conv-1" && where.userId === USER_A ? { id: "conv-1" } : null),
	};
	messages.rows.push({
		id: "m-1",
		conversationId: "conv-1",
		role: "budget-continue",
		createdAt: new Date(),
		content: JSON.stringify({ v: 1, kind: "budget-continue", offerId: "continue-run-1", runId: "run-1", budgetUsd: 1, status: "pending" }),
	});
});
afterEach(() => {
	installed.restore();
	(prisma as unknown as Record<string, unknown>).conversation = originalConversation;
});

function appFor(userId: string) {
	const outer = new Hono<AuthEnv>();
	outer.use("*", async (c, next) => {
		c.set("session", { user: { id: userId } } as AuthEnv["Variables"]["session"]);
		await next();
	});
	outer.route(
		"/",
		createBudgetContinueRoutes({
			queue: {} as never,
			enqueue: async (_queue, runId) => {
				enqueued.push(runId);
				return true;
			},
			resolve: (input) =>
				resolveBudgetContinue(input, {
					createRun: (async (args: Record<string, unknown>) => {
						created.push(args);
						runs.rows.push({ id: "run-2", userId: args.userId, conversationId: "conv-1", status: "queued", checkpointJson: {}, budgetJson: {} });
						return { id: "run-2" } as never;
					}) as never,
				}),
		}),
	);
	return outer;
}

const post = (app: Hono<AuthEnv>, body: unknown) =>
	app.request("/v1/cards/budget-continue/resolve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const valid = { conversationId: "conv-1", offerId: "continue-run-1", decision: "approved" };

test("aprovar cria o run de continuação com o orçamento do card (não o do corpo) e o enfileira", async () => {
	const res = await post(appFor(USER_A), { ...valid, budgetUsd: 999 });
	assert.equal(res.status, 200);
	const body = (await res.json()) as Record<string, unknown>;
	assert.deepEqual(body, { ok: true, status: "approved", unchanged: false, runId: "run-2", enqueued: true });
	assert.equal(((created[0]!.request as Record<string, unknown>).budget as Record<string, unknown>).maxCostUsd, 1);
	assert.deepEqual(enqueued, ["run-2"]);
});

test("aprovar de novo devolve o mesmo run e não cria nem enfileira outro", async () => {
	const app = appFor(USER_A);
	await post(app, valid);
	const again = (await (await post(app, valid)).json()) as Record<string, unknown>;
	assert.equal(again.unchanged, true);
	assert.equal(again.runId, "run-2");
	assert.equal(created.length, 1);
	assert.deepEqual(enqueued, ["run-2"]);
});

test("dispensar não cria run nem enfileira", async () => {
	const res = await post(appFor(USER_A), { ...valid, decision: "dismissed" });
	assert.equal(res.status, 200);
	assert.equal(((await res.json()) as Record<string, unknown>).status, "dismissed");
	assert.equal(created.length, 0);
	assert.deepEqual(enqueued, []);
});

test("outro usuário recebe 404 e nada é criado, enfileirado ou alterado", async () => {
	for (const decision of ["approved", "dismissed"]) {
		const res = await post(appFor(USER_B), { ...valid, decision });
		assert.equal(res.status, 404);
	}
	assert.equal(created.length, 0);
	assert.deepEqual(enqueued, []);
	assert.equal(JSON.parse(String(messages.rows[0]!.content)).status, "pending");
});

test("corpo inválido recebe 400", async () => {
	const app = appFor(USER_A);
	for (const bad of [{}, { ...valid, decision: "talvez" }, { ...valid, offerId: "" }, { ...valid, conversationId: 3 }]) {
		assert.equal((await post(app, bad)).status, 400);
	}
});
