/**
 * Resposta de questionário dentro de um trabalho longo do dono: o run criado herda turno humano, motor e perfil do último
 * run de chat da conversa (segue `long_work`, sem cair no teto da conta). Outro dono não herda nada. Prisma em memória.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { Hono } from "hono";
import type { AuthEnv } from "../middleware/auth.js";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-run-inheritance";
process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";

const { FakeTable, installFakes } = await import("@workspace/db/testing");
const { prisma } = await import("@workspace/db");
const { createRunRoutes } = await import("./runs.js");

const OWNER = "user-a";
let runs: InstanceType<typeof FakeTable>;
let messages: InstanceType<typeof FakeTable>;
let installed: { restore: () => void };
let originalConversation: unknown;

const card = JSON.stringify({
	v: 1,
	kind: "questionnaire",
	questionnaireId: "q-1",
	title: "Qual formato?",
	status: "pending",
	items: [{ name: "formato", prompt: "Formato do relatório", choices: [{ value: "pdf" }, { value: "docx" }] }],
	purpose: "task",
});

beforeEach(() => {
	runs = new FakeTable(
		[{ id: "parent", userId: OWNER, botId: null, conversationId: "conv-1", origin: "chat", status: "completed", model: "test/model", createdAt: new Date(1000), budgetJson: { humanTurn: true, engine: "v2", engineProfile: "long_work", contextLength: 1000 } }],
		() => ({ cancelRequested: false, jobEnqueuedAt: null, parentRunId: null, error: null, resultText: null, sandboxSessionId: null, maxSteps: 100, usageJson: null, startedAt: null, finishedAt: null, createdAt: new Date(), updatedAt: new Date() }),
	);
	messages = new FakeTable([{ id: "m-1", conversationId: "conv-1", role: "questionnaire", content: card, createdAt: new Date() }], () => ({ createdAt: new Date() }));
	installed = installFakes({ agentRun: runs, conversationMessage: messages, bot: new FakeTable([]) });
	const client = prisma as unknown as Record<string, unknown>;
	originalConversation = client.conversation;
	client.conversation = {
		findFirst: async ({ where }: { where: { id: string; userId: string } }) => (where.id === "conv-1" && where.userId === OWNER ? { id: "conv-1" } : null),
		findUnique: async () => ({ id: "conv-1" }),
	};
});
afterEach(() => {
	installed.restore();
	(prisma as unknown as Record<string, unknown>).conversation = originalConversation;
});

function appFor(userId: string) {
	const config = {
		port: 3001,
		hostname: "localhost",
		openRouterApiKey: "test-key",
		openRouterModel: "test/model",
		redisUrl: "",
		databaseUrl: undefined,
		chatQueue: null,
		routineQueue: null,
		agentRunQueue: { add: async () => ({ id: "job" }), getJob: async () => undefined },
	} as unknown as Parameters<typeof createRunRoutes>[0];
	const app = new Hono<AuthEnv>();
	app.use("*", async (c, next) => {
		c.set("session", { user: { id: userId }, session: { id: "s", userId } } as unknown as AuthEnv["Variables"]["session"]);
		await next();
	});
	app.route(
		"/",
		createRunRoutes(config, {
			validateModel: (async () => ({})) as never,
			getAccountConfig: (async () => ({})) as never,
			subscribeRunEvents: () => () => undefined,
		}),
	);
	return app;
}

const submit = (app: Hono<AuthEnv>) =>
	app.request("/v1/questionnaire/submit", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ conversationId: "conv-1", questionnaireId: "q-1", answers: { formato: "pdf" } }),
	});

test("resposta de questionário no trabalho longo do dono herda turno humano, motor e perfil do último run de chat", async () => {
	const response = await submit(appFor(OWNER));
	assert.equal(response.status, 202, await response.clone().text());
	const created = runs.rows.find((row) => row.id !== "parent")!;
	assert.deepEqual(
		{ humanTurn: (created.budgetJson as Record<string, unknown>).humanTurn, engine: (created.budgetJson as Record<string, unknown>).engine, engineProfile: (created.budgetJson as Record<string, unknown>).engineProfile },
		{ humanTurn: true, engine: "v2", engineProfile: "long_work" },
	);
});

test("conversa sem trabalho do dono: a resposta não ganha turno humano nem motor", async () => {
	runs.rows[0]!.budgetJson = { contextLength: 1000 };
	const response = await submit(appFor(OWNER));
	assert.equal(response.status, 202, await response.clone().text());
	const created = runs.rows.find((row) => row.id !== "parent")!;
	const budget = (created.budgetJson ?? {}) as Record<string, unknown>;
	assert.equal(budget.humanTurn, undefined);
	assert.equal(budget.engine, undefined);
});

test("outro dono recebe 404 e nada é criado", async () => {
	const response = await submit(appFor("user-b"));
	assert.equal(response.status, 404);
	assert.equal(runs.rows.length, 1);
});
