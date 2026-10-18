import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { Hono } from "hono";
import type { AuthEnv } from "../middleware/auth.js";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";
process.env.CONNECTOR_ENCRYPTION_KEY = randomBytes(32).toString("base64");

const { createVaultRoutes } = await import("./vault.js");
const { VaultService, memoryVaultStore } = await import("@workspace/agent-runtime");

const SECRET = "valor-super-secreto-987654";

function setup() {
	const store = memoryVaultStore();
	const vault = new VaultService(store);
	const routes = createVaultRoutes({ vault: () => vault, ready: () => true });
	const appFor = (userId: string) => {
		const app = new Hono<AuthEnv>();
		app.use("*", async (c, next) => {
			c.set("session", { user: { id: userId, email: "owner@example.com" } } as never);
			await next();
		});
		app.route("/", routes);
		return app;
	};
	return { store, vault, appFor };
}
const json = (body: unknown, method = "POST"): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("cria, lista só metadados, cifra em repouso e nunca devolve o valor fora do reveal", async () => {
	const { store, appFor } = setup();
	const a = appFor("alice");
	const created = await a.request("/v1/vault", json({ kind: "secret", name: "openai", description: "chave", value: SECRET }));
	assert.equal(created.status, 201);
	const { item } = (await created.json()) as { item: { id: string } };
	assert.ok(!JSON.stringify(store.rows).includes(SECRET), "valor não pode estar em claro no banco");
	const list = await a.request("/v1/vault");
	const text = await list.text();
	assert.ok(!text.includes(SECRET));
	assert.equal((JSON.parse(text) as { items: unknown[] }).items.length, 1);
	const noConfirm = await a.request(`/v1/vault/${item.id}/reveal`, json({}));
	assert.equal(noConfirm.status, 400);
	const reveal = await a.request(`/v1/vault/${item.id}/reveal`, json({ confirm: true }));
	assert.equal(reveal.status, 200);
	assert.equal(reveal.headers.get("cache-control"), "no-store");
	assert.equal(((await reveal.json()) as { payload: { value: string } }).payload.value, SECRET);
	const detail = (await (await a.request(`/v1/vault/${item.id}`)).json()) as { audit: Array<{ action: string }> };
	assert.ok(detail.audit.some((entry) => entry.action === "revealed"));
	assert.ok(detail.audit.some((entry) => entry.action === "created"));
});

test("outro usuário recebe 404 em tudo (isolamento por dono)", async () => {
	const { appFor } = setup();
	const created = await appFor("alice").request("/v1/vault", json({ kind: "secret", name: "k", value: SECRET }));
	const { item } = (await created.json()) as { item: { id: string } };
	const bob = appFor("bob");
	assert.equal((await bob.request(`/v1/vault/${item.id}`)).status, 404);
	assert.equal((await bob.request(`/v1/vault/${item.id}/reveal`, json({ confirm: true }))).status, 404);
	assert.equal((await bob.request(`/v1/vault/${item.id}`, json({ description: "x" }, "PATCH"))).status, 404);
	assert.equal((await bob.request(`/v1/vault/${item.id}/copy`, json({ what: "valor" }))).status, 404);
	assert.equal((await bob.request(`/v1/vault/${item.id}/totp`)).status, 404);
	assert.equal((await bob.request(`/v1/vault/${item.id}`, { method: "DELETE" })).status, 404);
	assert.deepEqual(((await (await bob.request("/v1/vault")).json()) as { items: unknown[] }).items, []);
	assert.equal((await appFor("alice").request(`/v1/vault/${item.id}`)).status, 200);
});

test("login com 2FA: código gerado na hora, renomear, editar sem apagar o valor, apagar", async () => {
	const { appFor } = setup();
	const a = appFor("alice");
	const created = await a.request("/v1/vault", json({ kind: "login", name: "github", label: "GitHub", siteUrl: "https://github.com", username: "ali", password: "Senha-123456", totp: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", extras: [{ name: "pin", value: "1234", secret: true }] }));
	assert.equal(created.status, 201);
	const { item } = (await created.json()) as { item: { id: string; domain: string } };
	assert.equal(item.domain, "github.com");
	const code = (await (await a.request(`/v1/vault/${item.id}/totp`)).json()) as { code: string };
	assert.match(code.code, /^\d{6}$/);
	const bad = await a.request("/v1/vault", json({ kind: "login", name: "x", password: "abcdef", totp: "###" }));
	assert.equal(bad.status, 400);
	const patched = await a.request(`/v1/vault/${item.id}`, json({ name: "github-pessoal", username: "ali2", password: "" }, "PATCH"));
	assert.equal(patched.status, 200);
	const revealed = (await (await a.request(`/v1/vault/${item.id}/reveal`, json({ confirm: true }))).json()) as { payload: { password: string } };
	assert.equal(revealed.payload.password, "Senha-123456");
	assert.equal((await a.request("/v1/vault", json({ kind: "secret", name: "github-pessoal", value: "abcdef" }))).status, 409);
	assert.equal((await a.request(`/v1/vault/${item.id}`, { method: "DELETE" })).status, 204);
	assert.equal((await a.request(`/v1/vault/${item.id}`)).status, 404);
});

test("POST /v1/vault/secrets (cartão do bot e composer): grava no dono, 'unique' evita sobrescrever", async () => {
	const { appFor, vault } = setup();
	const a = appFor("alice");
	const first = await a.request("/v1/vault/secrets", json({ entries: [{ name: "stripe-key", value: SECRET }] }));
	assert.equal(first.status, 201);
	assert.deepEqual(((await first.json()) as { saved: Array<{ name: string }> }).saved.map((s) => s.name), ["stripe-key"]);
	const again = await a.request("/v1/vault/secrets", json({ mode: "unique", entries: [{ name: "stripe-key", value: "outro-valor-123456" }] }));
	assert.deepEqual(((await again.json()) as { saved: Array<{ name: string }> }).saved.map((s) => s.name), ["stripe-key-2"]);
	const invalid = await a.request("/v1/vault/secrets", json({ entries: [{ name: "nome inválido", value: "x1x1x1" }] }));
	assert.equal(invalid.status, 400);
	assert.deepEqual((await vault.listMeta("bob")), []);
});
