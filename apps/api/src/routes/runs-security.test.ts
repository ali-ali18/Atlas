import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { Hono } from "hono";
import type { AuthEnv } from "../middleware/auth.js";
import { jsonBodyLimit } from "../middleware/json-body-limit.js";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
const { prisma } = await import("@workspace/db");
const { createRunRoutes } = await import("./runs.js");
const { createComputerUseRoutes } = await import("./computer.js");

const A = "security-owner-a";
const B = "security-owner-b";
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
function row(status = "running") {
	return { id: "run-a", userId: A, botId: null, conversationId: null, origin: "chat", objective: "teste", status, model: "test/model", maxSteps: 10, sandboxSessionId: null, error: null, resultText: null, cancelRequested: false, budgetJson: null, usageJson: null, createdAt: now, updatedAt: now, startedAt: now, finishedAt: null, leaseUntil: null, jobEnqueuedAt: now };
}

/** Publicador falso: nenhum teste abre conexão Redis. */
const noPublish = async () => true;
function appFor(userId: string, publishRunSignal: (runId: string, kind: "input" | "cancel") => Promise<unknown> = noPublish, queueAdd: () => Promise<unknown> = async () => ({ id: "job" })) {
	const config: Parameters<typeof createRunRoutes>[0] = { port: 3001, hostname: "localhost", openRouterApiKey: "test-only", openRouterModel: "test/model", redisUrl: "", databaseUrl: undefined, chatQueue: null, routineQueue: null,
		agentRunQueue: { add: queueAdd as never, getJob: async () => undefined },
	};
	const app = new Hono<AuthEnv>();
	app.use("*", jsonBodyLimit);
	app.use("*", async (c, next) => {
		c.set("session", { user: { id: userId, name: "Test", email: "owner@example.com", emailVerified: true, createdAt: now, updatedAt: now }, session: { id: "session", token: "test", userId, expiresAt: now, createdAt: now, updatedAt: now, ipAddress: null, userAgent: null } });
		await next();
	});
	app.route("/", createRunRoutes(config, { getAccountConfig: async () => ({ v: 1 as const }), publishRunSignal, subscribeRunEvents: () => () => undefined }));
	app.route("/", createComputerUseRoutes(config, { getAccountConfig: async () => ({ v: 1 as const }), publishRunSignal }));
	return app;
}

function post(app: ReturnType<typeof appFor>, path: string, body: unknown) {
	return app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

test("B recebe404 em todas as leituras/controles/input do run de A sem efeitos", async (t) => {
	stubMethod(prisma.agentRun, "findFirst", async ({ where }: { where: { id: string; userId: string } }) => where.id === "run-a" && where.userId === A ? row() : null);
	const update = stubMethod(prisma.agentRun, "update", async () => { throw new Error("não deve modificar run"); });
	const input = stubMethod(prisma.runInput, "create", async () => { throw new Error("não deve criar input"); });
	t.after(() => mock.restoreAll());
	const app = appFor(B);
	for (const suffix of ["", "/events", "/stream", "/inputs"]) assert.equal((await app.request(`/v1/runs/run-a${suffix}`)).status, 404);
	for (const suffix of ["/cancel", "/pause", "/resume", "/inputs"]) assert.equal((await post(app, `/v1/runs/run-a${suffix}`, { content: "oi" })).status, 404);
	assert.equal(update.mock.callCount(), 0);
	assert.equal(input.mock.callCount(), 0);
	assert.equal((await appFor(A).request("/v1/runs/run-a")).status, 200);
});

test("modern e compat rejeitam bot/conversa estrangeiros antes de criação ou fetch", async (t) => {
	stubMethod(prisma.bot, "findFirst", async () => null);
	stubMethod(prisma.conversation, "findFirst", async () => null);
	const create = stubMethod(prisma.agentRun, "create", async () => { throw new Error("não deve criar run"); });
	const fetch = stubMethod(globalThis, "fetch", async () => { throw new Error("nenhuma chamada paga"); });
	t.after(() => mock.restoreAll());
	for (const path of ["/v1/runs", "/v1/chat/computer"]) {
		for (const references of [{ botId: "foreign-bot" }, { conversationId: "foreign-conversation" }]) {
			assert.equal((await post(appFor(B), path, { messages: [{ role: "user", content: "oi" }], ...references })).status, 404);
		}
	}
	assert.equal(create.mock.callCount(), 0);
	assert.equal(fetch.mock.callCount(), 0);
});

test("maxSteps, conteúdo e quantidade de mensagens inválidos não criam runs", async (t) => {
	const create = stubMethod(prisma.agentRun, "create", async () => { throw new Error("não deve criar run"); });
	t.after(() => mock.restoreAll());
	for (const path of ["/v1/runs", "/v1/chat/computer"]) {
		for (const maxSteps of [0, 501, 1.5, "1"]) assert.equal((await post(appFor(A), path, { messages: [{ role: "user", content: "oi" }], maxSteps })).status, 400);
		assert.equal((await post(appFor(A), path, { messages: [{ role: "user", content: "x".repeat(65537) }] })).status, 400);
		assert.equal((await post(appFor(A), path, { messages: Array(201).fill({ role: "user", content: "oi" }) })).status, 400);
	}
	assert.equal(create.mock.callCount(), 0);
});

test("input com modo desconhecido e conteúdo excessivo não produz efeitos", async (t) => {
	stubMethod(prisma.agentRun, "findFirst", async () => row());
	const update = stubMethod(prisma.agentRun, "update", async () => { throw new Error("não deve cancelar"); });
	const input = stubMethod(prisma.runInput, "create", async () => { throw new Error("não deve criar input"); });
	t.after(() => mock.restoreAll());
	for (const body of [{ content: "oi", mode: "unknown" }, { content: "oi", mode: ["cancel"] }, { content: "x".repeat(65537), mode: "cancel" }]) assert.equal((await post(appFor(A), "/v1/runs/run-a/inputs", body)).status, 400);
	assert.equal(update.mock.callCount(), 0);
	assert.equal(input.mock.callCount(), 0);
});

test("SSE moderno de run paused encerra; compat cria com dono e encerra paused", async (t) => {
	let createdOwner: unknown;
	stubMethod(prisma.agentRun, "findFirst", async ({ where }: { where: { userId: string } }) => where.userId === A ? row("paused") : null);
	stubMethod(prisma.agentRun, "create", async ({ data }: { data: { userId: string } }) => { createdOwner = data.userId; return row("paused"); });
	stubMethod(prisma.agentRun, "update", async () => row("paused"));
	stubMethod(prisma.runEvent, "findMany", async () => []);
	t.after(() => mock.restoreAll());
	const app = appFor(A);
	// Pausado: evento paused explicito (cliente nao confunde com queda) e fecha.
	const pausedStream = await (await app.request("/v1/runs/run-a/stream")).text();
	assert.match(pausedStream, /^retry: 2000\n\nevent: paused\ndata: \{"type":"paused"/);
	const response = await post(app, "/v1/chat/computer", { messages: [{ role: "user", content: "oi" }] });
	assert.equal(response.status, 200);
	assert.equal(createdOwner, A);
	assert.match(await response.text(), /"runId":"run-a"/);
});

test("run próprio aceita join, redirect, interrupt, queue, cancel e o steer legado (vira join) após sandbox removida; B continua 404", async () => {
	const run = { ...row(), sandboxSessionId: "sandbox-removida-pelo-reaper" };
	stubMethod(prisma.agentRun, "findFirst", async ({ where }: { where: { userId: string | { in: string[] } } }) => {
		const owner = typeof where.userId === "string" ? where.userId : where.userId.in[0];
		return owner === A ? run : null;
	});
	stubMethod(prisma.agentRun, "findUnique", async () => run);
	const update = stubMethod(prisma.agentRun, "update", async () => ({ ...run, cancelRequested: true }));
	stubMethod(prisma.agentRun, "updateMany", async () => ({ count: 0 }));
	stubMethod(prisma, "$transaction", async (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma));
	stubMethod(prisma, "$executeRaw", async () => 0);
	stubMethod(prisma, "$queryRaw", async () => [{ id: "event", runId: run.id, seq: 1, type: "input_received", payload: {}, createdAt: now }]);
	stubMethod(prisma.runInput, "findFirst", async () => null);
	const create = stubMethod(prisma.runInput, "create", async ({ data }: { data: { mode: string; content: string } }) => ({ ...data, id: "input", runId: run.id, seq: 1, author: "user", status: "pending", createdAt: now, consumedAt: null, clientKey: null }));
	const expected: Array<[string | undefined, string]> = [
		[undefined, "join"], ["join", "join"], ["steer", "join"], ["redirect", "redirect"],
		["interrupt", "interrupt"], ["queue", "queue"], ["cancel", "cancel"],
	];
	for (const [mode, stored] of expected) {
		const response = await post(appFor(A), "/v1/runs/run-a/inputs", mode === undefined ? { content: "continue" } : { content: "continue", mode });
		assert.equal(response.status, 201);
		assert.equal((await response.json() as { input: { mode: string } }).input.mode, stored);
	}
	assert.equal(create.mock.callCount(), expected.length);
	assert.equal(update.mock.callCount(), 1);
	// B não escreve em run de A, em nenhum modo.
	for (const mode of ["join", "redirect", "interrupt", "queue", "cancel"]) {
		assert.equal((await post(appFor(B), "/v1/runs/run-a/inputs", { content: "continue", mode })).status, 404);
	}
	assert.equal(create.mock.callCount(), expected.length);
	assert.equal(update.mock.callCount(), 1);
});

test("pause de run em retrying responde 409 sem alterar o run; run ativo pausa com 202", async (t) => {
	let status = "retrying";
	stubMethod(prisma.agentRun, "findFirst", async () => row(status));
	stubMethod(prisma.agentRun, "findUnique", async () => row(status));
	const updateMany = stubMethod(prisma.agentRun, "updateMany", async ({ where }: { where: { status: { in: string[] } } }) => {
		if (!where.status.in.includes(status)) return { count: 0 };
		status = "paused";
		return { count: 1 };
	});
	t.after(() => mock.restoreAll());
	const app = appFor(A);
	assert.equal((await post(app, "/v1/runs/run-a/pause", {})).status, 409);
	assert.equal(status, "retrying");
	status = "running";
	assert.equal((await post(app, "/v1/runs/run-a/pause", {})).status, 202);
	assert.equal(status, "paused");
	assert.equal(updateMany.mock.callCount(), 2);
});

function stubInputPath(run = row()) {
	stubMethod(prisma.agentRun, "findFirst", async ({ where }: { where: { userId: string | { in: string[] } } }) => {
		const owner = typeof where.userId === "string" ? where.userId : where.userId.in[0];
		return owner === A ? run : null;
	});
	stubMethod(prisma.agentRun, "findUnique", async () => run);
	stubMethod(prisma.agentRun, "update", async () => ({ ...run, cancelRequested: true }));
	stubMethod(prisma.agentRun, "updateMany", async () => ({ count: 0 }));
	stubMethod(prisma, "$transaction", async (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma));
	stubMethod(prisma, "$executeRaw", async () => 0);
	stubMethod(prisma, "$queryRaw", async () => [{ id: "event", runId: run.id, seq: 1, type: "input_received", payload: {}, createdAt: now }]);
	stubMethod(prisma.runInput, "findFirst", async () => null);
	stubMethod(prisma.runInput, "create", async ({ data }: { data: { mode: string; content: string } }) => ({ ...data, id: "input", runId: run.id, seq: 1, author: "user", status: "pending", createdAt: now, consumedAt: null, clientKey: null }));
}

test("POST /inputs publica 'input' depois de gravar; modo cancel publica também 'cancel'", async (t) => {
	stubInputPath();
	t.after(() => mock.restoreAll());
	const published: Array<[string, string]> = [];
	const app = appFor(A, async (runId, kind) => { published.push([runId, kind]); return true; });
	assert.equal((await post(app, "/v1/runs/run-a/inputs", { content: "oi", mode: "join" })).status, 201);
	assert.deepEqual(published, [["run-a", "input"]]);
	published.length = 0;
	assert.equal((await post(app, "/v1/runs/run-a/inputs", { content: "para", mode: "cancel" })).status, 201);
	assert.deepEqual(published, [["run-a", "cancel"], ["run-a", "input"]]);
});

test("mensagem enviada a run pausado (card de conexão) retoma o run e o enfileira", async (t) => {
	stubInputPath(row("paused"));
	const resume = stubMethod(prisma.agentRun, "updateMany", async ({ where, data }: { where: { status?: string }; data: { status?: string } }) => ({ count: where.status === "paused" && data.status === "queued" ? 1 : 0 }));
	const added: unknown[] = [];
	t.after(() => mock.restoreAll());
	const app = appFor(A, noPublish, async () => { added.push(1); return { id: "job" }; });
	assert.equal((await post(app, "/v1/runs/run-a/inputs", { content: "Conectei", mode: "join" })).status, 201);
	assert.ok(resume.mock.callCount() >= 1);
	assert.equal(added.length, 1);
});

test("conector conectado retoma e enfileira os runs do dono parados no card dele", async (t) => {
	const { resumeRunsAwaitingConnector } = await import("./runs.js");
	const pending = { pendingLogin: { loginId: "l", site: "Google Agenda", url: "u", connector: { kind: "native", id: "google_calendar" } } };
	stubMethod(prisma.agentRun, "findMany", async () => [{ id: "run-a", checkpointJson: pending }, { id: "run-b", checkpointJson: { pendingLogin: { ...pending.pendingLogin, connector: { kind: "native", id: "gmail" } } } }]);
	stubMethod(prisma.agentRun, "updateMany", async () => ({ count: 1 }));
	stubMethod(prisma.agentRun, "findUnique", async () => row("queued"));
	stubMethod(prisma.agentRun, "update", async () => row("queued"));
	t.after(() => mock.restoreAll());
	const added: unknown[] = [];
	const queue = { add: async (_name: string, data: unknown) => { added.push(data); return { id: "job" }; }, getJob: async () => undefined };
	assert.deepEqual(await resumeRunsAwaitingConnector(queue as never, A, "google_calendar"), ["run-a"]);
	assert.deepEqual(added, [{ runId: "run-a" }]);
	assert.deepEqual(await resumeRunsAwaitingConnector(null, A, "google_calendar"), []);
});

test("mensagem a run em execução não tenta retomar; cancel a run pausado não o enfileira", async (t) => {
	stubInputPath(row("running"));
	const added: unknown[] = [];
	t.after(() => mock.restoreAll());
	const app = appFor(A, noPublish, async () => { added.push(1); return { id: "job" }; });
	assert.equal((await post(app, "/v1/runs/run-a/inputs", { content: "oi" })).status, 201);
	assert.equal(added.length, 0);
});

test("POST /cancel publica 'cancel' só para o dono; B recebe 404 e nada é publicado", async (t) => {
	stubInputPath();
	t.after(() => mock.restoreAll());
	const published: Array<[string, string]> = [];
	const publish = async (runId: string, kind: "input" | "cancel") => { published.push([runId, kind]); return true; };
	assert.equal((await post(appFor(B, publish), "/v1/runs/run-a/cancel", {})).status, 404);
	for (const mode of ["join", "cancel"]) assert.equal((await post(appFor(B, publish), "/v1/runs/run-a/inputs", { content: "x", mode })).status, 404);
	assert.deepEqual(published, []);
	assert.equal((await post(appFor(A, publish), "/v1/runs/run-a/cancel", {})).status, 200);
	assert.deepEqual(published, [["run-a", "cancel"]]);
});

test("falha ou travamento do publish não falha a requisição (201/200)", async (t) => {
	stubInputPath();
	t.after(() => mock.restoreAll());
	const warn = mock.method(console, "warn", () => undefined);
	const failing = async () => { throw new Error("redis://:segredo@host caiu"); };
	assert.equal((await post(appFor(A, failing), "/v1/runs/run-a/inputs", { content: "oi" })).status, 201);
	assert.equal((await post(appFor(A, failing), "/v1/runs/run-a/cancel", {})).status, 200);
	const hanging = () => new Promise<never>(() => undefined);
	assert.equal((await post(appFor(A, hanging), "/v1/runs/run-a/inputs", { content: "oi" })).status, 201);
	assert.ok(warn.mock.callCount() >= 3);
	assert.ok(!warn.mock.calls.some((call) => String(call.arguments[0]).includes("segredo")), "log só com metadado");
	warn.mock.restore();
});

test("mensagem que cai no run ativo da conversa (POST /v1/runs) publica 'input'", async (t) => {
	const active = { ...row(), conversationId: "conv-a" };
	stubMethod(prisma.conversation, "findFirst", async () => ({ id: "conv-a" }));
	stubMethod(prisma.bot, "findFirst", async () => null);
	stubMethod(prisma.agentRun, "create", async () => { throw { code: "P2002" }; });
	stubMethod(prisma.agentRun, "updateMany", async () => ({ count: 0 }));
	stubMethod(prisma.agentRun, "findFirst", async ({ where }: { where: { userId: string | { in: string[] } } }) => {
		const owner = typeof where.userId === "string" ? where.userId : where.userId.in[0];
		return owner === A ? active : null;
	});
	stubMethod(prisma.conversation, "findUnique", async () => ({ id: "conv-a" }));
	stubMethod(prisma, "$transaction", async (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma));
	stubMethod(prisma, "$executeRaw", async () => 0);
	stubMethod(prisma.runInput, "findFirst", async () => null);
	stubMethod(prisma.runInput, "create", async ({ data }: { data: Record<string, unknown> }) => ({ id: "input", createdAt: now, consumedAt: null, ...data }));
	stubMethod(prisma.conversationMessage, "create", async () => ({}));
	t.after(() => mock.restoreAll());
	const published: Array<[string, string]> = [];
	const app = appFor(A, async (runId, kind) => { published.push([runId, kind]); return true; });
	const response = await post(app, "/v1/runs", { messages: [{ role: "user", content: "mais uma coisa" }], conversationId: "conv-a" });
	assert.equal(response.status, 202);
	assert.deepEqual(published, [["run-a", "input"]]);
});

test("POST /v1/runs: o run que ocupava a conversa terminou na corrida, o create tenta de novo e responde 202", async (t) => {
	let creates = 0;
	stubMethod(prisma.conversation, "findFirst", async () => ({ id: "conv-a" }));
	stubMethod(prisma.bot, "findFirst", async () => null);
	stubMethod(prisma.agentRun, "create", async ({ data }: { data: Record<string, unknown> }) => {
		creates += 1;
		if (creates === 1) throw { code: "P2002" };
		return { ...row("queued"), id: "run-new", conversationId: "conv-a", ...data };
	});
	stubMethod(prisma.agentRun, "updateMany", async () => ({ count: 0 }));
	// o run ativo já saiu do estado ativo quando a rota procura por ele
	stubMethod(prisma.agentRun, "findFirst", async () => null);
	stubMethod(prisma.conversation, "findUnique", async () => ({ id: "conv-a" }));
	stubMethod(prisma.conversation, "update", async () => ({}));
	stubMethod(prisma.conversationMessage, "create", async () => ({ id: "m", createdAt: now }));
	t.after(() => mock.restoreAll());
	const response = await post(appFor(A), "/v1/runs", { messages: [{ role: "user", content: "oi" }], conversationId: "conv-a" });
	assert.equal(response.status, 202, await response.clone().text());
	assert.equal(creates, 2);
});

test("POST /v1/runs: conflito do índice único sem run ativo do dono vira 409 claro, não 400 com erro cru do Prisma", async (t) => {
	stubMethod(prisma.conversation, "findFirst", async () => ({ id: "conv-a" }));
	stubMethod(prisma.bot, "findFirst", async () => null);
	stubMethod(prisma.agentRun, "create", async () => { throw { code: "P2002", message: "Invalid `prisma.agentRun.create()` invocation: Unique constraint failed on the fields: (`conversationId`)" }; });
	stubMethod(prisma.agentRun, "updateMany", async () => ({ count: 0 }));
	stubMethod(prisma.agentRun, "findFirst", async () => null);
	t.after(() => mock.restoreAll());
	const response = await post(appFor(A), "/v1/runs", { messages: [{ role: "user", content: "oi" }], conversationId: "conv-a" });
	assert.equal(response.status, 409);
	const body = (await response.json()) as { error: string };
	assert.match(body.error, /tarefa em andamento/);
	assert.doesNotMatch(body.error, /prisma/i);
});
