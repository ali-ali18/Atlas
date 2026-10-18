import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { Hono } from "hono";
import type { AuthEnv } from "../middleware/auth.js";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-provider-runs";
const { prisma } = await import("@workspace/db");
const { SiwcAuthError } = await import("@workspace/agent-runtime");
const { createProviderModelValidator } =
	await import("../providers/model-catalog.js");
const { createRunRoutes } = await import("./runs.js");
const now = new Date("2026-10-04T12:00:00Z");
const restorers: Array<() => void> = [];
function stub(
	object: object,
	key: string,
	value: (...args: never[]) => unknown
) {
	const original = Object.getOwnPropertyDescriptor(object, key);
	Object.defineProperty(object, key, {
		value,
		configurable: true,
		writable: true,
	});
	restorers.push(() => {
		if (original) Object.defineProperty(object, key, original);
		else Reflect.deleteProperty(object, key);
	});
}
afterEach(() => {
	for (const restore of restorers.reverse()) restore();
	restorers.length = 0;
});

function fixture(
	options: {
		userId?: string;
		enabled?: boolean;
		connected?: boolean;
		known?: boolean | null;
		apiKey?: string;
	} = {}
) {
	const calls: string[] = [];
	const userId = options.userId ?? "a";
	const validateModel = createProviderModelValidator(
		{
			assertOwner: async (id) => {
				if (id !== "a") throw new SiwcAuthError("not_found", 404);
			},
			status: async (id) => {
				calls.push(`status:${id}`);
				if (options.enabled === false || id !== "a")
					throw new SiwcAuthError("not_found", 404);
				return {
					provider: "chatgpt",
					status: options.connected === false ? "needs_login" : "connected",
					accountEmail: null,
					updatedAt: null,
					lastLimitAt: null,
				};
			},
		},
		{
			isKnown: async (id, model) => {
				calls.push(`catalog:${id}:${model}`);
				return options.known === undefined ? true : options.known;
			},
		},
		async () => ({ enabled: options.enabled !== false, source: "user" as const })
	);
	stub(
		prisma.conversation,
		"findFirst",
		async ({ where }: { where: { userId: string } }) =>
			where.userId === "a" ? { id: "conv-a" } : null
	);
	stub(
		prisma.bot,
		"findFirst",
		async ({
			where,
		}: {
			where: {
				ownerId?: string | { in: string[] };
				id?: unknown;
			};
		}) => {
			calls.push("bot:read");
			const owners = typeof where.ownerId === "object" ? where.ownerId.in : [where.ownerId];
			return owners.includes("a") &&
				typeof where.id === "string"
				? { id: "bot-a", conversationId: null, openRouterModel: "chatgpt/luna" }
				: null;
		}
	);
	stub(
		prisma.agentRun,
		"create",
		async ({ data }: { data: { userId: string; model: string } }) => {
			calls.push(`create:${data.userId}:${data.model}`);
			return {
				...data,
				id: "run-a",
				botId: null,
				conversationId: null,
				origin: "chat",
				objective: "teste",
				status: "queued",
				maxSteps: 10,
				sandboxSessionId: null,
				error: null,
				resultText: null,
				cancelRequested: false,
				budgetJson: null,
				usageJson: null,
				createdAt: now,
				updatedAt: now,
				startedAt: null,
				finishedAt: null,
			};
		}
	);
	stub(prisma.agentRun, "update", async () => {
		calls.push("mark:enqueued");
		return {};
	});
	stub(prisma.conversationMessage, "findMany", async () => {
		calls.push("card:read");
		return [];
	});
	const config: Parameters<typeof createRunRoutes>[0] = {
		port: 3001,
		hostname: "localhost",
		openRouterApiKey: options.apiKey,
		openRouterModel: "test/model",
		redisUrl: "",
		databaseUrl: undefined,
		chatQueue: null,
		routineQueue: null,
		agentRunQueue: {
			add: async () => {
				calls.push("enqueue");
				return { id: "job" };
			},
			getJob: async () => undefined,
		},
	};
	const app = new Hono<AuthEnv>();
	app.use("*", async (c, next) => {
		c.set("session", {
			user: {
				id: userId,
				name: "Fixture",
				email: "owner@example.com",
				emailVerified: true,
				createdAt: now,
				updatedAt: now,
			},
			session: {
				id: "session",
				token: "fixture",
				userId,
				expiresAt: now,
				createdAt: now,
				updatedAt: now,
				ipAddress: null,
				userAgent: null,
			},
		});
		await next();
	});
	app.route("/", createRunRoutes(config, { validateModel, subscribeRunEvents: () => () => undefined }));
	return { app, calls };
}
function post(
	app: ReturnType<typeof fixture>["app"],
	path: string,
	body: unknown
) {
	return app.request(path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}
const body = {
	messages: [{ role: "user", content: "gere o PDF" }],
	model: "chatgpt/luna",
	userId: "b",
};
const questionnaire = {
	conversationId: "conv-a",
	questionnaireId: "card-a",
	botId: "bot-a",
	answers: { detail: "PDF" },
	userId: "b",
};
function assertNoEffects(calls: string[]) {
	assert.ok(
		!calls.some(
			(call) =>
				call.startsWith("create:") || call === "enqueue" || call === "card:read"
		)
	);
}

test("ChatGPT conectado cria run sem chave OpenRouter usando apenas dono da sessão", async () => {
	const { app, calls } = fixture();
	const response = await post(app, "/v1/runs?userId=b", body);
	assert.equal(response.status, 202);
	assert.deepEqual(await response.json(), {
		runId: "run-a",
		status: "queued",
		enqueued: true,
	});
	assert.deepEqual(calls, [
		"status:a",
		"catalog:a:chatgpt/luna",
		"create:a:chatgpt/luna",
		"enqueue",
		"mark:enqueued",
	]);
});

test("sem conexão, modelo ausente e catálogo indisponível impedem efeitos", async () => {
	for (const options of [
		{ connected: false },
		{ known: false },
		{ known: null },
	]) {
		const { app, calls } = fixture(options);
		const response = await post(app, "/v1/runs", body);
		assert.equal(response.status, options.known === null ? 409 : 400);
		assert.match(
			await response.text(),
			/Conecte|Modelo ChatGPT|Catálogo ChatGPT/
		);
		assertNoEffects(calls);
	}
});

test("B não usa conexão de A pelo body: 404 sem consultar o catálogo", async () => {
	const { app, calls } = fixture({ userId: "b" });
	const response = await post(app, "/v1/runs?userId=a", {
		...body,
		userId: "a",
	});
	assert.equal(response.status, 404);
	assert.ok(!calls.some((call) => call.startsWith("catalog:")));
	assertNoEffects(calls);
});

test("plano ChatGPT desligado para o dono: 400 com a instrução em pt-BR, sem efeitos", async () => {
	const { app, calls } = fixture({ enabled: false });
	const response = await post(app, "/v1/runs", body);
	assert.equal(response.status, 400);
	assert.match(await response.text(), /Ative o plano ChatGPT em Configurações/);
	assert.ok(!calls.some((call) => call.startsWith("catalog:")));
	assertNoEffects(calls);
});

test("slug inválido retorna 400 e OpenRouter sem chave mantém 503", async () => {
	const { app, calls } = fixture();
	assert.equal(
		(await post(app, "/v1/runs", { ...body, model: "chatgpt/path/invalid" }))
			.status,
		400
	);
	assert.equal(
		(await post(app, "/v1/runs", { ...body, model: "openai/gpt-4o-mini" }))
			.status,
		503
	);
	assert.deepEqual(calls, []);
});

test("questionário herda ChatGPT do bot e valida antes de consumir card", async () => {
	for (const options of [
		{ connected: false },
		{ known: false },
		{ known: null },
	]) {
		const { app, calls } = fixture(options);
		const response = await post(app, "/v1/questionnaire/submit", questionnaire);
		assert.equal(response.status, options.known === null ? 409 : 400);
		assert.equal(calls.filter((call) => call === "status:a").length, 1);
		assertNoEffects(calls);
	}
});

test("questionário de A é 404 para B antes de consultar conexão ou consumir card", async () => {
	const { app, calls } = fixture({ userId: "b" });
	assert.equal(
		(await post(app, "/v1/questionnaire/submit", questionnaire)).status,
		404
	);
	assert.deepEqual(calls, []);
});
