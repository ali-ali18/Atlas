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
	stubMethod(prisma.agentRun, "findMany", async () => []);
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
			checkModel: async () => null,
			contextLength: () => null,
			maskMessages: (async (_user: string, messages: unknown[]) => messages) as never,
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
	assert.deepEqual(await startBotOnboarding({ ...base, queue: null }), { outcome: "skipped", reason: "no_queue" });
	assert.deepEqual(
		await startBotOnboarding({ ...base, bot: { id: "b", name: "L", conversationId: null }, queue: {} as never }),
		{ outcome: "skipped", reason: "no_conversation" },
	);
	mock.method(console, "warn", () => undefined);
	const failed = await startBotOnboarding(
		{ ...base, queue: {} as never },
		{
			findExisting: async () => null,
			resolveModel: async () => ({ model: "e/m", auto: false }),
			checkModel: async () => null,
			contextLength: () => null,
			maskMessages: (async (_user: string, messages: unknown[]) => messages) as never,
			createRun: (async () => ({ id: "run-1" })) as never,
			enqueue: async () => { throw new Error("redis down"); },
		},
	);
	assert.deepEqual(failed, { outcome: "failed" });
});

test("findBotCreatedRun filtra pelo dono: usuário B não enxerga o onboarding do bot de A", async () => {
	const runs = [{ id: "run-a", userId: "user-a", conversationId: "conv-1", objective: "[Bot-Created] Perguntas de onboarding do Lia", status: "completed", budgetJson: null, jobEnqueuedAt: null }];
	stubMethod(prisma.agentRun, "findMany", async ({ where }: { where: Row }) =>
		runs.filter((row) => row.userId === where.userId && row.conversationId === where.conversationId && row.objective.toLowerCase().startsWith("[bot-created]")));
	assert.deepEqual(await findBotCreatedRun("user-a", "conv-1"), { id: "run-a", status: "completed", enqueued: true });
	assert.equal(await findBotCreatedRun("user-b", "conv-1"), null);
	assert.equal(await findBotCreatedRun("user-a", "conv-outra"), null, "[bot-created] em outra conversa não casa");
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
	stubMethod(prisma.agentRun, "findMany", async () => [{ id: "run-server", status: "running", budgetJson: null, jobEnqueuedAt: null }]);
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

const baseInput = { bot: { id: "bot-1", name: "Lia", description: "vendas", conversationId: "conv-1" }, userId: "user-a", queue: {} as never, envDefault: "env/model" };
const okDeps = {
	findExisting: async () => null,
	resolveModel: async () => ({ model: "env/model", auto: false }),
	checkModel: async () => null,
	contextLength: () => 200_000,
	maskMessages: (async (_user: string, messages: unknown[]) => messages) as never,
	enqueue: async () => true,
};

test("startBotOnboarding: modelo sem chave ou fora do catálogo não cria run e devolve skipped com motivo", async () => {
	mock.method(console, "warn", () => undefined);
	let created = 0;
	const result = await startBotOnboarding(baseInput, {
		...okDeps,
		checkModel: async () => ({ error: "OPENROUTER_API_KEY is not configured on the API server" }),
		createRun: (async () => { created += 1; return { id: "x" }; }) as never,
	});
	assert.deepEqual(result, { outcome: "skipped", reason: "model_unavailable" });
	assert.equal(created, 0);
});

test("checkRunModel (o do POST /v1/runs): sem chave OpenRouter e catálogo indisponível bloqueiam; modelo bom passa", async () => {
	const { checkRunModel } = await import("./runs.js");
	const ok = async () => ({});
	assert.equal(await checkRunModel("u", "google/gemini-2.5-flash", { validateModel: ok, openRouterApiKey: "k" }), null);
	assert.equal((await checkRunModel("u", "google/gemini-2.5-flash", { validateModel: ok, openRouterApiKey: undefined }))?.status, 503);
	assert.equal((await checkRunModel("u", "x/y", { validateModel: async () => ({ status: 400, error: "unknown" }), openRouterApiKey: "k" }))?.status, 400);
	assert.equal((await checkRunModel("u", "x/y", { validateModel: async () => ({ warning: "catalog down" }), openRouterApiKey: "k" }))?.status, 409);
});

test("startBotOnboarding passa contextLength e mascara segredos nas mensagens", async () => {
	const created: Array<{ contextLength?: number | null; request: { messages: Array<{ role: string; content: string }> } }> = [];
	await startBotOnboarding(baseInput, {
		...okDeps,
		maskMessages: (async (_user: string, messages: Array<{ role: string; content: string }>) =>
			messages.map((m) => (m.role === "user" ? { ...m, content: m.content.replace("vendas", "[segredo]") } : m))) as never,
		createRun: (async (input: never) => { created.push(input); return { id: "run-1" }; }) as never,
	});
	assert.equal(created[0]?.contextLength, 200_000);
	assert.match(created[0]!.request.messages[1]!.content, /\[segredo\]/);
	assert.doesNotMatch(created[0]!.request.messages[1]!.content, /vendas/);
});

test("startBotOnboarding: o idioma resolvido entra no prompt do run", async () => {
	const created: Array<{ request: { messages: Array<{ role: string; content: string }> } }> = [];
	await startBotOnboarding({ ...baseInput, language: "en-US" }, {
		...okDeps,
		createRun: (async (input: never) => { created.push(input); return { id: "run-1" }; }) as never,
	});
	assert.match(created[0]!.request.messages[0]!.content, /## Language/);
	assert.match(created[0]!.request.messages[0]!.content, /Always reply to the user in /);
});

test("POST /v1/bots passa ao onboarding o idioma do bot, ou o do navegador no modo auto, ou pt-BR", async () => {
	stubBotCreate();
	const languages: unknown[] = [];
	const app = appFor("user-a", async (input) => { languages.push((input as { language?: unknown }).language); return { outcome: "skipped", reason: "x" }; });
	const send = (body: Row, acceptLanguage?: string) => app.request("/v1/bots", {
		method: "POST",
		headers: { "Content-Type": "application/json", ...(acceptLanguage ? { "Accept-Language": acceptLanguage } : {}) },
		body: JSON.stringify(body),
	});
	await send({ name: "A", language: "auto" }, "en-US,en;q=0.9");
	await send({ name: "B", language: "auto" });
	await send({ name: "C", language: "es-ES" }, "en-US");
	assert.deepEqual(languages, ["en-US", "pt-BR", "es-ES"]);
});

function runsApp(userId: string) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		(c as unknown as { set: (k: string, v: unknown) => void }).set("session", { user: { id: userId } });
		await next();
	});
	app.route("/", createRunRoutes({ agentRunQueue: { add: async () => ({}), getJob: async () => undefined } } as never));
	return app;
}
const runBody = (extra: Row) => JSON.stringify({
	messages: [{ role: "user", content: "{}" }], botId: "bot-1", conversationId: "conv-1", origin: "chat",
	objective: "[bot-created] Perguntas de onboarding do Lia", silent: true, ...extra,
});
const postRun = (app: ReturnType<typeof runsApp>, body: string) =>
	app.request("/v1/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body });

function stubOwned(runs: Row[]) {
	stubMethod(prisma.conversation, "findFirst", async () => ({ id: "conv-1" }));
	stubMethod(prisma.bot, "findFirst", async ({ where }: { where: { id?: string; memberIds?: unknown } }) =>
		where.id === "bot-1" && !where.memberIds ? { id: "bot-1", conversationId: "conv-1" } : null);
	return stubMethod(prisma.agentRun, "findMany", async () => runs);
}

test("POST /v1/runs: guarda não bloqueia conversa comum (não silenciosa) que começa com [bot-created]", async () => {
	const findMany = stubOwned([{ id: "run-server", status: "running", budgetJson: null, jobEnqueuedAt: null }]);
	const response = await postRun(runsApp("user-a"), runBody({ silent: false }));
	assert.notDeepEqual(await response.json().catch(() => null), { runId: "run-server", status: "running", enqueued: true });
	assert.equal(findMany.mock.callCount(), 0, "nem consulta o guarda");
});

test("POST /v1/runs: run digitado pelo dono (humanTurn) com o marcador não conta como onboarding", async () => {
	stubOwned([{ id: "run-typed", status: "completed", budgetJson: { humanTurn: true }, jobEnqueuedAt: null }]);
	const response = await postRun(runsApp("user-a"), runBody({}));
	const body = (await response.json().catch(() => ({}))) as { runId?: string };
	assert.notEqual(body.runId, "run-typed");
});

test("POST /v1/runs: sem onboarding existente o pedido segue adiante (não é respondido pelo guarda)", async () => {
	const findMany = stubOwned([]);
	const response = await postRun(runsApp("user-a"), runBody({}));
	assert.equal(findMany.mock.callCount(), 1);
	assert.notEqual(response.status, 200);
});

test("POST /v1/runs: o 200 do guarda reflete o job (queued sem job = enqueued:false)", async () => {
	stubOwned([{ id: "run-q", status: "queued", budgetJson: null, jobEnqueuedAt: null }]);
	const response = await postRun(runsApp("user-a"), runBody({}));
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { runId: "run-q", status: "queued", enqueued: false });
});

test("POST /v1/runs: outro dono recebe 404 e nunca vê o run de onboarding", async () => {
	stubMethod(prisma.conversation, "findFirst", async ({ where }: { where: { userId?: string } }) => (where.userId === "user-a" ? { id: "conv-1" } : null));
	stubMethod(prisma.bot, "findFirst", async ({ where }: { where: { ownerId?: string } }) => (where.ownerId === "user-a" ? { id: "bot-1", conversationId: "conv-1" } : null));
	const findMany = stubMethod(prisma.agentRun, "findMany", async () => [{ id: "run-server", status: "running", budgetJson: null, jobEnqueuedAt: null }]);
	const response = await postRun(runsApp("user-b"), runBody({}));
	assert.equal(response.status, 404);
	assert.equal(findMany.mock.callCount(), 0);
});
