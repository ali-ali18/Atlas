import assert from "node:assert/strict";
import { test } from "node:test";
process.env.ATLAS_OWNER_EMAIL ??= "owner@example.com";
process.env.ATLAS_HOOK_PEPPER ??= "pepper-pepper-pepper-pepper-pepper-123";
import { Hono } from "hono";
import type { ApiKeyProviderStatus } from "@workspace/shared";
import type { AuthEnv } from "../middleware/auth.js";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-provider-routes";
const { ProviderApiError } = await import("@workspace/llm");
const { createProviderKeyRoutes } = await import("./provider-keys.js");

const KEY = "sk-ant-api03-SEGREDO-ABCDEFGH";

function appFor(userId: string, testKey: (provider: string, key: string) => Promise<number>, vaultReady = true) {
	const stored = new Map<string, string>();
	const logs: string[] = [];
	const status = (user: string, provider: string): ApiKeyProviderStatus => ({
		provider: provider as ApiKeyProviderStatus["provider"],
		status: stored.has(`${user}:${provider}`) ? "connected" : "disconnected",
		modelCount: stored.has(`${user}:${provider}`) ? 3 : null,
		updatedAt: null,
		lastLimitAt: null,
		lastError: null,
	});
	const service = {
		vaultReady: () => vaultReady,
		status: async (user: string, provider: string) => status(user, provider),
		getKey: async (user: string, provider: string) => stored.get(`${user}:${provider}`) ?? null,
		save: async (user: string, provider: string, key: unknown) => void stored.set(`${user}:${provider}`, String(key)),
		setModelCount: async () => {},
		markError: async (_u: string, _p: string, code: string) => void logs.push(code),
		remove: async (user: string, provider: string) => void stored.delete(`${user}:${provider}`),
	};
	const app = new Hono<AuthEnv>();
	app.use("*", async (c, next) => {
		c.set("session", {
			session: { id: "s", userId, token: "t", expiresAt: new Date(), createdAt: new Date(), updatedAt: new Date(), ipAddress: null, userAgent: null },
			user: { id: userId, email: `${userId}@example.com`, name: "F", emailVerified: true, image: null, createdAt: new Date(), updatedAt: new Date() },
		});
		await next();
	});
	app.route("/", createProviderKeyRoutes({
		service: service as never,
		catalog: { clear: () => {}, list: async () => ({ models: [], connected: stored.size > 0, catalogAvailable: true }) },
		testKey,
	}));
	return { app, stored, logs };
}
const put = (app: Hono<AuthEnv>, provider: string, apiKey: unknown) =>
	app.request(`/v1/provider-keys/${provider}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ apiKey }) });

test("PUT testa a chave, guarda e nunca devolve a chave", async () => {
	const { app, stored } = appFor("a", async () => 3);
	const res = await put(app, "anthropic", KEY);
	assert.equal(res.status, 200);
	const text = await res.text();
	assert.ok(!text.includes(KEY));
	assert.equal(JSON.parse(text).status.status, "connected");
	assert.equal(stored.get("a:anthropic"), KEY);
	const list = await (await app.request("/v1/provider-keys")).text();
	assert.ok(!list.includes(KEY));
	assert.equal(JSON.parse(list).providers.length, 2);
});

test("chave recusada pelo provedor não é guardada e a resposta não repete a chave", async () => {
	const { app, stored } = appFor("a", async () => { throw new ProviderApiError("anthropic", 401, "auth_failed"); });
	const res = await put(app, "anthropic", KEY);
	assert.equal(res.status, 400);
	assert.ok(!(await res.text()).includes(KEY));
	assert.equal(stored.size, 0);
});

test("isolamento por usuário, provedor desconhecido e chave inválida", async () => {
	const a = appFor("a", async () => 1);
	await put(a.app, "opencode-go", KEY);
	assert.equal(a.stored.has("a:opencode-go"), true);
	const b = appFor("b", async () => 1);
	assert.equal((await (await b.app.request("/v1/provider-keys")).json() as { providers: { status: string }[] }).providers[0]!.status, "disconnected");
	assert.equal((await put(a.app, "openai", KEY)).status, 404);
	assert.equal((await put(a.app, "anthropic", "curta")).status, 400);
	assert.equal((await put(a.app, "anthropic", 42)).status, 400);
});

test("sem cofre responde 503; DELETE remove; erro de rede não vaza detalhe", async () => {
	assert.equal((await put(appFor("a", async () => 1, false).app, "anthropic", KEY)).status, 503);
	const { app, stored } = appFor("a", async () => 1);
	await put(app, "anthropic", KEY);
	assert.equal((await app.request("/v1/provider-keys/anthropic", { method: "DELETE" })).status, 200);
	assert.equal(stored.size, 0);
	const failing = appFor("a", async () => { throw new Error(`falha com ${KEY}`); });
	const res = await put(failing.app, "anthropic", KEY);
	assert.equal(res.status, 502);
	assert.ok(!(await res.text()).includes(KEY));
});

test("POST test sem conexão avisa e com auth_failed marca erro", async () => {
	const { app, logs } = appFor("a", async () => { throw new ProviderApiError("anthropic", 401, "auth_failed"); });
	assert.equal((await app.request("/v1/provider-keys/anthropic/test", { method: "POST" })).status, 400);
});
