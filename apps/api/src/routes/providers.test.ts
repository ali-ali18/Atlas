import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import type { ChatgptAuthService, ChatgptGateResolver } from "@workspace/agent-runtime";


import type { AuthEnv } from "../middleware/auth.js";
process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-provider-routes";
const { SiwcAuthError } = await import("@workspace/agent-runtime");
const { createProviderRoutes } = await import("./providers.js");
const { createSiwcCallbackHandler } = await import("../providers/siwc-loopback.js");
const env = {
	ATLAS_PROVIDER_CHATGPT_ENABLED: "true",
	ATLAS_OWNER_EMAIL: "owner@example.com",
	ATLAS_URL: "http://localhost:3000",
};
function appFor(email: string, config = env, gate?: ChatgptGateResolver, deviceError?: Error) {
	const calls: string[] = [];
	const service: ChatgptAuthService = {
		assertOwner: async () => {},
		status: async (id) => {
			calls.push(`status:${id}`);
			return {
				provider: "chatgpt",
				status: "connected",
				accountEmail: "account@example.com",
				updatedAt: null,
				lastLimitAt: null,
			};
		},
		connect: async (id) => {
			calls.push(`connect:${id}`);
			return {
				authorizeUrl:
					"https://auth.openai.com/api/accounts/authorize?state=fixture",
			};
		},
		disconnect: async (id) => {
			calls.push(`disconnect:${id}`);
			return { revocationConfirmed: false };
		},
		callback: async () => {},
		startDeviceLogin: async (id) => {
			calls.push(`device-start:${id}`);
			if (deviceError) throw deviceError;
			return { userCode: "ABCD-12345", verificationUrl: "https://auth.openai.com/codex/device", expiresAt: "2030-01-01T00:00:00.000Z", intervalSeconds: 5 };
		},
		pollDeviceLogin: async (id) => {
			calls.push(`device-poll:${id}`);
			if (deviceError) throw deviceError;
			return { status: "connected" };
		},
		getAccountId: async () => null,
		getAccessToken: async () => "fixture-private-token",
		markNeedsLogin: async () => {},
	};
	const app = new Hono<AuthEnv>();
	app.use("*", async (c, next) => {
		c.set("session", {
			session: {
				id: "session",
				userId: "a",
				token: "fixture-session",
				expiresAt: new Date(),
				createdAt: new Date(),
				updatedAt: new Date(),
				ipAddress: null,
				userAgent: null,
			},
			user: {
				id: email === env.ATLAS_OWNER_EMAIL ? "a" : "b",
				email,
				name: "Fixture",
				emailVerified: true,
				image: null,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});
		await next();
	});
	app.route(
		"/",
		createProviderRoutes(service, async () => {}, config, { list: async (id, selected) => { calls.push(`models:${id}:${selected}`); return { models: [], status: "connected", catalogAvailable: false }; } }, gate),
	);
	return { app, calls };
}
test("dono obtém status/conecta/desconecta; userId externo ignorado e tokens ausentes", async () => {
	const { app, calls } = appFor(env.ATLAS_OWNER_EMAIL);
	assert.equal((await app.request("/v1/providers?userId=b")).status, 200);
	assert.equal(
		(
			await app.request("/v1/providers/chatgpt/connect?userId=b", {
				method: "POST",
				body: JSON.stringify({ userId: "b" }),
			})
		).status,
		200,
	);
	assert.equal(
		(await app.request("/v1/providers/chatgpt", { method: "DELETE" })).status,
		200,
	);
	assert.deepEqual(calls, ["status:a", "connect:a", "disconnect:a"]);
	assert.ok(
		!(await (await app.request("/v1/providers")).text()).includes(
			"fixture-private-token",
		),
	);
});
test("B e flag off recebem 404 em todas rotas sem chamar serviço", async () => {
	for (const fixture of [
		appFor("other@example.com"),
		appFor(env.ATLAS_OWNER_EMAIL, {
			...env,
			ATLAS_PROVIDER_CHATGPT_ENABLED: "false",
		}),
	]) {
		for (const [path, method] of [
			["/v1/providers", "GET"],
			["/v1/providers/chatgpt/connect", "POST"],
			["/v1/providers/chatgpt/models?userId=a", "GET"],
			["/v1/providers/chatgpt", "DELETE"],
		])
			assert.equal((await fixture.app.request(path!, { method })).status, 404);
		assert.deepEqual(fixture.calls, []);
	}
});
test("callback sem cookie somente GET /callback loopback e redirect sem tokens", async () => {
	let count = 0;
	const handler = createSiwcCallbackHandler(
		{
			callback: async () => {
				count++;
			},
		},
		env,
	);
	const response = await handler(
		new Request(
			"http://127.0.0.1:53682/callback?state=fixture&code=fixture-code",
		),
	);
	assert.equal(response.status, 302);
	assert.equal(
		response.headers.get("location"),
		"http://localhost:3000/providers/callback?provider=chatgpt&status=ok",
	);
	for (const request of [
		new Request("http://127.0.0.1:53682/health"),
		new Request("http://127.0.0.1:53682/callback", { method: "POST" }),
		new Request("http://localhost:53682/callback"),
		new Request("http://127.0.0.1:53682/callback", {
			headers: { host: "attacker.example" },
		}),
	])
		assert.equal((await handler(request)).status, 404);
	assert.equal(count, 1);
	const failure = createSiwcCallbackHandler(
		{
			callback: async () => {
				throw new Error("fixture-private-token");
			},
		},
		env,
	);
	const failed = await failure(
		new Request("http://127.0.0.1:53682/callback?state=bad"),
	);
	assert.equal(
		failed.headers.get("location"),
		"http://localhost:3000/providers/callback?provider=chatgpt&status=error",
	);
	// Erro conhecido do serviço: só o código seguro vai na URL (nunca code/state/token).
	const known = createSiwcCallbackHandler(
		{
			callback: async () => {
				throw new SiwcAuthError("invalid_token_response:scope");
			},
		},
		env,
	);
	const withCode = await known(
		new Request("http://127.0.0.1:53682/callback?state=s&code=secret-auth-code"),
	);
	assert.equal(
		withCode.headers.get("location"),
		"http://localhost:3000/providers/callback?provider=chatgpt&status=error&code=invalid_token_response%3Ascope",
	);
	assert.doesNotMatch(withCode.headers.get("location")!, /secret-auth-code|state=s/);
	const unsafe = createSiwcCallbackHandler(
		{
			callback: async () => {
				throw new SiwcAuthError("Bearer abc.def/ghi");
			},
		},
		env,
	);
	assert.equal(
		(await unsafe(new Request("http://127.0.0.1:53682/callback?state=s"))).headers.get("location"),
		"http://localhost:3000/providers/callback?provider=chatgpt&status=error",
	);
	assert.equal(
		(
			await handler(
				new Request("http://127.0.0.1:53682/callback?state=a&state=b"),
			)
		).status,
		400,
	);
});

test("catálogo recebe apenas dono da sessão e preserva seleção oculta", async () => {
 const { app, calls } = appFor(env.ATLAS_OWNER_EMAIL);
 const response = await app.request("/v1/providers/chatgpt/models?userId=b&selected=chatgpt/hidden");
 assert.equal(response.status, 200);
 assert.deepEqual(await response.json(), { models: [], status: "connected", catalogAvailable: false });
 assert.deepEqual(calls, ["models:a:chatgpt/hidden"]);
});

const envOff = { ...env, ATLAS_PROVIDER_CHATGPT_ENABLED: "false" };
const gateFor = (enabled: boolean, source: "user" | "env" | "default"): ChatgptGateResolver => async () => ({ enabled, source });

test("env desligado é só o padrão: o dono que ligou na conta usa as rotas", async () => {
	const { app, calls } = appFor(env.ATLAS_OWNER_EMAIL, envOff, gateFor(true, "user"));
	assert.equal((await app.request("/v1/providers")).status, 200);
	assert.equal((await app.request("/v1/providers/chatgpt/connect", { method: "POST" })).status, 200);
	assert.deepEqual(calls, ["status:a", "connect:a"]);
});

test("ligado na conta, quem não é o dono continua recebendo 404 sem chamar serviço", async () => {
	const { app, calls } = appFor("other@example.com", env, gateFor(true, "user"));
	for (const [path, method] of [
		["/v1/providers", "GET"],
		["/v1/providers/chatgpt/connect", "POST"],
		["/v1/providers/chatgpt", "DELETE"],
	])
		assert.equal((await app.request(path!, { method })).status, 404);
	assert.deepEqual(calls, []);
});

test("desligado pelo usuário: só desconectar continua aberto; env desligado nunca abre nada", async () => {
	const byUser = appFor(env.ATLAS_OWNER_EMAIL, env, gateFor(false, "user"));
	for (const [path, method] of [
		["/v1/providers", "GET"],
		["/v1/providers/chatgpt/connect", "POST"],
		["/v1/providers/chatgpt/models", "GET"],
	])
		assert.equal((await byUser.app.request(path!, { method })).status, 404);
	assert.equal((await byUser.app.request("/v1/providers/chatgpt", { method: "DELETE" })).status, 200);
	assert.deepEqual(byUser.calls, ["disconnect:a"]);

	const byEnv = appFor(env.ATLAS_OWNER_EMAIL, envOff, gateFor(false, "env"));
	assert.equal((await byEnv.app.request("/v1/providers/chatgpt", { method: "DELETE" })).status, 404);
	assert.deepEqual(byEnv.calls, []);
});

test("falha ao resolver o plano responde 404 e não chama o serviço", async () => {
	const { app, calls } = appFor(env.ATLAS_OWNER_EMAIL, env, async () => {
		throw new Error("db fora");
	});
	assert.equal((await app.request("/v1/providers")).status, 404);
	assert.deepEqual(calls, []);
});

test("o callback não depende do env: quem valida plano e dono é o serviço (state → userId)", async () => {
	let count = 0;
	const handler = createSiwcCallbackHandler(
		{ callback: async () => { count++; } },
		{ ATLAS_URL: "http://localhost:3000" },
	);
	const response = await handler(new Request("http://127.0.0.1:53682/callback?state=fixture&code=c"));
	assert.equal(response.status, 302);
	assert.equal(count, 1);
	const refused = createSiwcCallbackHandler(
		{ callback: async () => { throw new Error("not_found"); } },
		{ ATLAS_URL: "http://localhost:3000" },
	);
	assert.equal(
		(await refused(new Request("http://127.0.0.1:53682/callback?state=fixture&code=c"))).headers.get("location"),
		"http://localhost:3000/providers/callback?provider=chatgpt&status=error",
	);
});


test("login por código: dono inicia e consulta com o userId da sessão, sem device_auth_id na resposta", async () => {
	const { app, calls } = appFor(env.ATLAS_OWNER_EMAIL);
	const start = await app.request("/v1/providers/chatgpt/device/start?userId=b", { method: "POST" });
	assert.equal(start.status, 200);
	const text = await start.text();
	assert.deepEqual(JSON.parse(text), { userCode: "ABCD-12345", verificationUrl: "https://auth.openai.com/codex/device", expiresAt: "2030-01-01T00:00:00.000Z", intervalSeconds: 5 });
	const poll = await app.request("/v1/providers/chatgpt/device/poll", { method: "POST" });
	assert.deepEqual(await poll.json(), { status: "connected" });
	assert.deepEqual(calls, ["device-start:a", "device-poll:a"]);
});

test("login por código: não-dono recebe 404 sem chamar o serviço", async () => {
	const { app, calls } = appFor("other@example.com");
	for (const path of ["start", "poll"])
		assert.equal((await app.request("/v1/providers/chatgpt/device/" + path, { method: "POST" })).status, 404);
	assert.deepEqual(calls, []);
});

test("login por código: erros viram código seguro, nunca o texto do provedor", async () => {
	const { app } = appFor(env.ATLAS_OWNER_EMAIL, env, undefined, new SiwcAuthError("device_failed", 400));
	const response = await app.request("/v1/providers/chatgpt/device/poll", { method: "POST" });
	assert.equal(response.status, 400);
	assert.deepEqual(await response.json(), { error: "Não foi possível concluir o login do ChatGPT", code: "device_failed" });
	const down = appFor(env.ATLAS_OWNER_EMAIL, env, undefined, new Error("token=secret-value")).app;
	const failed = await down.request("/v1/providers/chatgpt/device/start", { method: "POST" });
	assert.equal(failed.status, 503);
	assert.ok(!(await failed.text()).includes("secret-value"));
});
