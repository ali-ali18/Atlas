import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";

const { prisma } = await import("@workspace/db");
const { Hono } = await import("hono");
const { createBotRoutes } = await import("./bots.js");
const { createRunRoutes } = await import("./runs.js");
const { startBotOnboarding, findBotCreatedRun } = await import("../chat/bot-onboarding.js");

const restores: Array<() => void> = [];
function stubMethod(target: object, name: string, implementation: (...args: never[]) => unknown) {
	const original = Reflect.get(target, name);
	const fn = mock.fn(implementation);
	Object.assign(target, { [name]: fn });
	restores.push(() => Object.assign(target, { [name]: original }));
	return fn;
}
afterEach(() => {
	for (const restore of restores.splice(0).reverse()) restore();
	mock.restoreAll();
});

type Row = Record<string, unknown>;
const NOW = new Date("2026-11-03T12:00:00.000Z");
const botRow = (data: Row): Row => ({
	id: "bot-new", name: "Lia", snippet: "", color: "#fff", shape: "rond", description: null, openRouterModel: null,
	language: "pt-BR", pinned: false, pinOrder: null, sectionId: null, memberIds: [], conversationId: "conv-new",
	policyJson: null, ownerId: "user-a", createdAt: NOW, updatedAt: NOW, ...data,
});

function stubBotCreate() {
	stubMethod(prisma.conversation, "create", async () => ({ id: "conv-new" }));
	return stubMethod(prisma.bot, "create", async ({ data }: { data: Row }) => botRow(data));
}

type StartCall = { bot: { id: string; name: string }; userId: string };
function appFor(userId: string, start: (input: StartCall) => Promise<unknown>, queue: object | null = {}) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		(c as unknown as { set: (k: string, v: unknown) => void }).set("session", { user: { id: userId } });
		await next();
	});
	app.route("/", createBotRoutes({ onboarding: { queue: queue as never, envDefault: "test/model", start: start as never } }));
	return app;
}
const post = (app: ReturnType<typeof appFor>, body: unknown) =>
	app.request("/v1/bots", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("POST /v1/bots dispara exatamente um onboarding, com o dono da sessão", async () => {
	stubBotCreate();
	const calls: StartCall[] = [];
	const app = appFor("user-a", async (input) => { calls.push(input); return { outcome: "started", runId: "r1" }; });
	const response = await post(app, { name: "Lia", language: "pt-BR", userId: "user-b", ownerId: "user-b" });
	assert.equal(response.status, 201);
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.userId, "user-a", "o dono vem da sessão, nunca do corpo");
	assert.equal(calls[0]?.bot.id, "bot-new");
});

test("POST /v1/bots com onboarding:false não dispara", async () => {
	stubBotCreate();
	let calls = 0;
	const app = appFor("user-a", async () => { calls += 1; return { outcome: "started", runId: "r1" }; });
	const response = await post(app, { name: "Lia", language: "pt-BR", onboarding: false });
	assert.equal(response.status, 201);
	assert.equal(calls, 0);
});

test("POST /v1/bots de grupo (memberIds) não dispara onboarding", async () => {
	stubBotCreate();
	stubMethod(prisma.bot, "findMany", async () => [{ id: "m1" }, { id: "m2" }]);
	let calls = 0;
	const app = appFor("user-a", async () => { calls += 1; return { outcome: "started", runId: "r1" }; });
	const response = await post(app, { name: "Time", language: "pt-BR", memberIds: ["m1", "m2"] });
	assert.equal(response.status, 201);
	assert.equal(calls, 0);
});

test("POST /v1/bots: falha do onboarding (lança ou fila quebrada) não derruba o 201", async () => {
	stubBotCreate();
	const throwing = appFor("user-a", async () => { throw new Error("boom"); });
	assert.equal((await post(throwing, { name: "Lia", language: "pt-BR" })).status, 201);

	// Caminho real: createRun lança dentro do serviço, que devolve failed sem propagar.
	const warn = mock.method(console, "warn", () => undefined);
	stubMethod(prisma.agentRun, "findFirst", async () => null);
	stubMethod(prisma.agentRun, "create", async () => { throw new Error("db down secret-token-123"); });
	stubMethod(prisma.conversation, "findFirst", async () => ({ id: "conv-new" }));
	stubMethod(prisma.bot, "findMany", async () => []);
	const real = new Hono();
	real.use("*", async (c, next) => {
		(c as unknown as { set: (k: string, v: unknown) => void }).set("session", { user: { id: "user-a" } });
		await next();
	});
	real.route("/", createBotRoutes({ onboarding: { queue: { add: async () => ({}), getJob: async () => undefined }, envDefault: "test/model" } }));
	stubMethod(prisma.bot, "findFirst", async () => ({ id: "bot-new", policyJson: null, openRouterModel: "a/b" }));
	const response = await post(real, { name: "Lia", language: "pt-BR" });
	assert.equal(response.status, 201);
	assert.ok(warn.mock.callCount() >= 1, "registra aviso");
	assert.ok(!warn.mock.calls.some((call) => call.arguments.some((arg) => String(arg).includes("secret-token-123"))), "o aviso não carrega a mensagem do erro");
});

test("startBotOnboarding cria o run com objective, flags e chave certos e enfileira", async () => {
	const created: Row[] = [];
	const enqueued: string[] = [];
	const result = await startBotOnboarding(
		{ bot: { id: "bot-1", name: "Lia", description: "vendas", conversationId: "conv-1" }, userId: "user-a", queue: {} as never, envDefault: "env/model" },
		{
			findExisting: async () => null,
			resolveModel: async () => ({ model: "env/model", auto: true }),
			createRun: (async (input: Row) => { created.push(input); return { id: "run-1", status: "queued" }; }) as never,
			enqueue: async (_queue, runId) => { enqueued.push(runId); return true; },
		},
	);
	assert.deepEqual(result, { outcome: "started", runId: "run-1" });
	assert.deepEqual(enqueued, ["run-1"]);
	assert.equal(created.length, 1);
	const input = created[0] as { userId: string; modelAuto: boolean; request: Row & { messages: Array<{ role: string; content: string }> } };
	assert.equal(input.userId, "user-a");
	assert.equal(input.request.botId, "bot-1");
	assert.equal(input.request.conversationId, "conv-1");
	assert.equal(input.request.origin, "chat");
	assert.equal(input.request.silent, true);
	assert.equal(input.request.clientKey, "bot-created:bot-1");
	assert.equal(input.request.objective, "[bot-created] Perguntas de onboarding do Lia");
	assert.equal(input.request.messages[0]?.role, "system");
	assert.deepEqual(JSON.parse(input.request.messages[1]!.content), { event: "bot-created", name: "Lia", description: "vendas" });
});

test("startBotOnboarding não duplica: run de onboarding existente (repetição ou web antigo) bloqueia", async () => {
	let created = 0;
	const result = await startBotOnboarding(
		{ bot: { id: "bot-1", name: "Lia", conversationId: "conv-1" }, userId: "user-a", queue: {} as never, envDefault: "env/model" },
		{
			findExisting: async () => ({ id: "run-old" }),
			createRun: (async () => { created += 1; return { id: "x" }; }) as never,
		},
	);
	assert.deepEqual(result, { outcome: "duplicate", runId: "run-old" });
	assert.equal(created, 0);
});

test("startBotOnboarding sem fila ou sem conversa não faz nada; erro da fila vira failed", async () => {
	const base = { bot: { id: "bot-1", name: "Lia", conversationId: "conv-1" }, userId: "user-a", envDefault: "e/m" };
	assert.deepEqual(await startBotOnboarding({ ...base, queue: null }), { outcome: "skipped" });
	assert.deepEqual(
		await startBotOnboarding({ ...base, bot: { id: "b", name: "L", conversationId: null }, queue: {} as never }),
		{ outcome: "skipped" },
	);
	mock.method(console, "warn", () => undefined);
	const failed = await startBotOnboarding(
		{ ...base, queue: {} as never },
		{
			findExisting: async () => null,
			resolveModel: async () => ({ model: "e/m", auto: false }),
			createRun: (async () => ({ id: "run-1" })) as never,
			enqueue: async () => { throw new Error("redis down"); },
		},
	);
	assert.deepEqual(failed, { outcome: "failed" });
});

test("findBotCreatedRun filtra pelo dono: usuário B não enxerga o onboarding do bot de A", async () => {
	const runs = [{ id: "run-a", userId: "user-a", conversationId: "conv-1", objective: "[bot-created] Perguntas de onboarding do Lia", status: "completed" }];
	stubMethod(prisma.agentRun, "findFirst", async ({ where }: { where: Row }) =>
		runs.find((row) => row.userId === where.userId && row.conversationId === where.conversationId && row.objective.startsWith("[bot-created]")) ?? null);
	assert.equal((await findBotCreatedRun("user-a", "conv-1"))?.id, "run-a");
	assert.equal(await findBotCreatedRun("user-b", "conv-1"), null);
});

test("POST /v1/bots: usuário B (sessão) cria o seu e o onboarding roda no dono B, nunca no bot de A", async () => {
	stubBotCreate();
	const calls: StartCall[] = [];
	const app = appFor("user-b", async (input) => { calls.push(input); return { outcome: "started", runId: "r" }; });
	await post(app, { name: "Lia", language: "pt-BR" });
	assert.deepEqual(calls.map((call) => call.userId), ["user-b"]);
});

test("POST /v1/runs: web antigo pedindo o onboarding de um bot que o servidor já iniciou recebe o run existente, sem criar outro", async () => {
	stubMethod(prisma.conversation, "findFirst", async () => ({ id: "conv-1" }));
	// A consulta de grupo (memberIds não vazio) não acha nada: é um bot comum.
	stubMethod(prisma.bot, "findFirst", async ({ where }: { where: { id?: string; memberIds?: unknown } }) =>
		where.id === "bot-1" && !where.memberIds ? { id: "bot-1", conversationId: "conv-1" } : null);
	stubMethod(prisma.agentRun, "findFirst", async () => ({ id: "run-server", status: "running" }));
	const create = stubMethod(prisma.agentRun, "create", async () => ({ id: "run-dup" }));
	const app = new Hono();
	app.use("*", async (c, next) => {
		(c as unknown as { set: (k: string, v: unknown) => void }).set("session", { user: { id: "user-a" } });
		await next();
	});
	app.route("/", createRunRoutes({ agentRunQueue: { add: async () => ({}), getJob: async () => undefined } } as never));
	const response = await app.request("/v1/runs", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			messages: [{ role: "user", content: "{}" }],
			botId: "bot-1",
			conversationId: "conv-1",
			origin: "chat",
			objective: "[bot-created] Perguntas de onboarding do Lia",
			clientKey: "bot-created:bot-1:abc123",
			silent: true,
		}),
	});
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { runId: "run-server", status: "running", enqueued: true });
	assert.equal(create.mock.callCount(), 0);
});
