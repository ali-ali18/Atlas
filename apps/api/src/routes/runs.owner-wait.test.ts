/**
 * Motor v3 (PR8a), "esperar o dono" nas rotas: "Pular" no questionário, questionário ignorado (o dono mandou outra
 * mensagem) e a saída do cartão de login/VM no resume. Prisma em memória; outro dono recebe 404 e nada muda.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { Hono } from "hono";
import type { AuthEnv } from "../middleware/auth.js";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-owner-wait-routes";
process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";

const { FakeTable, installFakes } = await import("@workspace/db/testing");
const { prisma } = await import("@workspace/db");
const { createRunRoutes } = await import("./runs.js");
const { createReturnRoutes } = await import("./returns.js");

const OWNER = "user-a";
let runs: InstanceType<typeof FakeTable>;
let messages: InstanceType<typeof FakeTable>;
let installed: { restore: () => void };
let originalConversation: unknown;

const questionnaire = (status = "pending") =>
	JSON.stringify({ v: 1, kind: "questionnaire", questionnaireId: "questionnaire-asker", title: "Qual formato?", status, items: [{ name: "formato", prompt: "Formato", choices: [{ value: "pdf" }, { value: "pptx" }] }], purpose: "task" });

beforeEach(() => {
	runs = new FakeTable(
		[{ id: "asker", userId: OWNER, botId: null, conversationId: "conv-1", origin: "chat", status: "completed", model: "test/model", createdAt: new Date(1000), budgetJson: { humanTurn: true, engine: "v3" }, checkpointJson: null, updatedAt: new Date(1000), cancelRequested: false, jobEnqueuedAt: null, parentRunId: null, error: null, resultText: null, sandboxSessionId: null, maxSteps: 100, usageJson: null, startedAt: null, finishedAt: null }],
		() => ({ cancelRequested: false, jobEnqueuedAt: null, parentRunId: null, error: null, resultText: null, sandboxSessionId: null, maxSteps: 100, usageJson: null, startedAt: null, finishedAt: null, createdAt: new Date(), updatedAt: new Date() }),
	);
	messages = new FakeTable([{ id: "m-1", conversationId: "conv-1", role: "questionnaire", content: questionnaire(), createdAt: new Date() }], () => ({ createdAt: new Date() }));
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
	app.route("/", createRunRoutes(config, { validateModel: (async () => ({})) as never, getAccountConfig: (async () => ({})) as never, subscribeRunEvents: () => () => undefined }));
	return app;
}

const post = (app: Hono<AuthEnv>, path: string, body: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const seedOf = (row: Record<string, unknown> | undefined) => (row?.checkpointJson as { transcriptSeed?: { fromRunId: string; toolName?: string; resultContent: string; refused?: string[] } } | undefined)?.transcriptSeed;
const cardStatus = () => (JSON.parse(String(messages.rows.find((row) => row.role === "questionnaire")!.content)) as { status: string }).status;

test("Pular no questionário: cartão dispensado e o run continua sem a resposta, sem perguntar de novo", async () => {
	const response = await post(appFor(OWNER), "/v1/questionnaire/skip", { conversationId: "conv-1", questionnaireId: "questionnaire-asker" });
	assert.equal(response.status, 202, await response.clone().text());
	assert.equal(cardStatus(), "dismissed");
	const created = runs.rows.find((row) => row.id !== "asker");
	const seed = seedOf(created);
	assert.equal(seed?.fromRunId, "asker");
	assert.equal(seed?.toolName, "propose_questionnaire");
	assert.match(seed?.resultContent ?? "", /Owner skipped this step/);
	assert.match(seed?.resultContent ?? "", /Continue the rest of the task without it/);
	assert.deepEqual(seed?.refused, ["tool:propose_questionnaire"]);
	assert.equal((created?.budgetJson as Record<string, unknown>).engine, "v3");
});

test("Pular: outro dono recebe 404 e o cartão continua pendente; cartão já respondido = 404", async () => {
	assert.equal((await post(appFor("user-b"), "/v1/questionnaire/skip", { conversationId: "conv-1", questionnaireId: "questionnaire-asker" })).status, 404);
	assert.equal(cardStatus(), "pending");
	messages.rows[0]!.content = questionnaire("submitted");
	assert.equal((await post(appFor(OWNER), "/v1/questionnaire/skip", { conversationId: "conv-1", questionnaireId: "questionnaire-asker" })).status, 404);
	assert.equal(runs.rows.length, 1);
});

test("questionário do v3 ignorado: a fala nova vira o resultado da pergunta e o cartão vira Dispensado", async () => {
	const response = await post(appFor(OWNER), "/v1/runs", { messages: [{ role: "user", content: "esquece, faz em pdf mesmo" }], conversationId: "conv-1" });
	assert.equal(response.status, 202, await response.clone().text());
	assert.equal(cardStatus(), "dismissed");
	const seed = seedOf(runs.rows.find((row) => row.id !== "asker"));
	assert.equal(seed?.toolName, "propose_questionnaire");
	assert.match(seed?.resultContent ?? "", /did not answer the previous request \("Qual formato\?"\) and sent: "esquece, faz em pdf mesmo"/);
	// A fala continua sendo do dono (turno humano).
	assert.equal((runs.rows.find((row) => row.id !== "asker")!.budgetJson as Record<string, unknown>).humanTurn, true);
});

test("questionário de run v2 ignorado: nada muda (v1/v2 iguais)", async () => {
	runs.rows[0]!.budgetJson = { humanTurn: true, engine: "v2" };
	const response = await post(appFor(OWNER), "/v1/runs", { messages: [{ role: "user", content: "outra coisa" }], conversationId: "conv-1" });
	assert.equal(response.status, 202, await response.clone().text());
	assert.equal(cardStatus(), "pending");
	assert.equal(seedOf(runs.rows.find((row) => row.id !== "asker")), undefined);
});

test("resume com via=skip/takeover grava a saída do cartão de login no checkpoint; sem via = Terminei; outro dono 404", async () => {
	for (const [via, outcome] of [["skip", "skipped"], ["takeover", "takeover"], [undefined, "done"]] as const) {
		runs.rows[0]!.status = "paused";
		runs.rows[0]!.checkpointJson = { version: 2, messages: [], pendingLogin: { loginId: "login-1", site: "gemini.google.com", url: "https://gemini.google.com" } };
		const response = await post(appFor(OWNER), "/v1/runs/asker/resume", via ? { via } : {});
		assert.equal(response.status, 202, await response.clone().text());
		assert.equal((runs.rows[0]!.checkpointJson as { pendingLogin: { outcome?: string } }).pendingLogin.outcome, outcome);
	}
	// A saída já está no checkpoint quando o run é liberado (o worker ou o reconcile nunca pegam o run sem ela).
	runs.rows[0]!.status = "paused";
	runs.rows[0]!.checkpointJson = { version: 2, messages: [], pendingLogin: { loginId: "login-1", site: "x", url: "https://x" } };
	const table = prisma.agentRun as unknown as { updateMany: (args: { data: Record<string, unknown> }) => Promise<{ count: number }> };
	const original = table.updateMany.bind(table);
	let outcomeAtResume: string | undefined | null = null;
	table.updateMany = async (args) => {
		if (args.data.status === "queued") outcomeAtResume = (runs.rows[0]!.checkpointJson as { pendingLogin: { outcome?: string } }).pendingLogin.outcome;
		return original(args);
	};
	await post(appFor(OWNER), "/v1/runs/asker/resume", { via: "skip" });
	table.updateMany = original;
	assert.equal(outcomeAtResume, "skipped");

	runs.rows[0]!.status = "paused";
	runs.rows[0]!.checkpointJson = { version: 2, messages: [], pendingLogin: { loginId: "login-1", site: "x", url: "https://x" } };
	assert.equal((await post(appFor("user-b"), "/v1/runs/asker/resume", { via: "skip" })).status, 404);
	assert.equal((runs.rows[0]!.checkpointJson as { pendingLogin: { outcome?: string } }).pendingLogin.outcome, undefined);
});

test("retornos: o dono lista o visível e cancela; outro dono recebe 404 e o retorno segue", async () => {
	const rows = [
		{ id: "ret1", userId: OWNER, botId: null, conversationId: "conv-1", sourceRunId: "asker", dueAt: new Date("2026-11-04T18:30:00Z"), reason: "ver o deploy", visible: true, status: "pending" as const, runId: null, createdAt: new Date() },
		{ id: "ret2", userId: OWNER, botId: null, conversationId: "conv-1", sourceRunId: "asker", dueAt: new Date("2026-11-04T19:00:00Z"), reason: "silencioso", visible: false, status: "pending" as const, runId: null, createdAt: new Date() },
	];
	const cancelledJobs: string[] = [];
	const routes = createReturnRoutes({
		conversationOwned: async (conversationId, userId) => conversationId === "conv-1" && userId === OWNER,
		list: async (userId, conversationId) => rows.filter((row) => row.userId === userId && row.conversationId === conversationId && row.status === "pending"),
		cancel: async (userId, returnId, conversationId) => {
			const row = rows.find((item) => item.id === returnId && item.userId === userId && item.conversationId === conversationId && item.status === "pending");
			if (!row) return null;
			(row as { status: string }).status = "cancelled";
			return { ...row, status: "cancelled" as const };
		},
		cancelJob: async (id) => { cancelledJobs.push(id); },
	});
	const app = (userId: string) => {
		const shell = new Hono<AuthEnv>();
		shell.use("*", async (c, next) => {
			c.set("session", { user: { id: userId }, session: { id: "s", userId } } as unknown as AuthEnv["Variables"]["session"]);
			await next();
		});
		shell.route("/", routes);
		return shell;
	};
	const listed = (await (await app(OWNER).request("/v1/conversations/conv-1/returns")).json()) as { returns: Array<{ id: string }> };
	assert.deepEqual(listed.returns.map((item) => item.id), ["ret1"]);
	assert.equal((await app("user-b").request("/v1/conversations/conv-1/returns")).status, 404);
	assert.equal((await post(app("user-b"), "/v1/conversations/conv-1/returns/ret1/cancel", {})).status, 404);
	assert.equal(rows[0]!.status, "pending");
	assert.equal((await post(app(OWNER), "/v1/conversations/conv-1/returns/ret1/cancel", {})).status, 200);
	assert.equal(rows[0]!.status, "cancelled");
	assert.deepEqual(cancelledJobs, ["ret1"]);
	assert.equal((await post(app(OWNER), "/v1/conversations/conv-1/returns/ret1/cancel", {})).status, 404);
});
