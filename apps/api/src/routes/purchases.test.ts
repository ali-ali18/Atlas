/**
 * Rotas de compras (F6.5) com um banco falso que filtra por dono como o real.
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/routes/purchases.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import type { PurchaseRecord } from "@workspace/db";
import type { AuthEnv } from "../middleware/auth.js";
import { createPurchaseRoutes, type PurchaseRouteDeps } from "./purchases.js";

type Row = PurchaseRecord & { userId: string };
const row = (userId: string, id: string, botId: string | null, purchasedAt: string): Row => ({ userId, id, botId, merchant: "Loja", items: [{ name: "Fone", quantity: 1 }], total: 10, currency: "BRL", purchasedAt, createdAt: purchasedAt, deliveryWatchId: "watch-secret" });

function appWith(userId = "u1") {
	const rows = [row("u1", "p1", "b1", "2026-11-01T00:00:00.000Z"), row("u1", "p2", null, "2026-11-03T00:00:00.000Z"), row("u2", "p3", "b2", "2026-11-02T00:00:00.000Z")];
	const calls: string[] = [];
	const deps: PurchaseRouteDeps = {
		botOwned: async (user, botId) => (user === "u1" && botId === "b1") || (user === "u2" && botId === "b2"),
		list: async (user, options) => (calls.push(`list:${user}:${options.botId ?? "-"}:${options.limit}`), rows.filter((r) => r.userId === user && (!options.botId || r.botId === options.botId)).sort((a, b) => b.purchasedAt.localeCompare(a.purchasedAt))),
		get: async (user, id) => rows.find((r) => r.userId === user && r.id === id) ?? null,
	};
	const app = new Hono<AuthEnv>();
	app.use("*", async (c, next) => {
		c.set("session", { user: { id: userId } } as AuthEnv["Variables"]["session"]);
		await next();
	});
	app.route("/", createPurchaseRoutes(deps));
	return { app, calls };
}
const json = async (r: Response) => (await r.json()) as Record<string, any>;

test("lista só as do dono da sessão, mais recente primeiro, sem campo interno", async () => {
	const { app } = appWith("u1");
	const res = await app.request("/v1/purchases");
	assert.equal(res.status, 200);
	const body = await json(res);
	assert.deepEqual(body.purchases.map((p: { id: string }) => p.id), ["p2", "p1"]);
	assert.ok(!JSON.stringify(body).includes("watch-secret") && !JSON.stringify(body).includes("deliveryWatchId"));
});

test("IDOR: o usuário B não lê a compra do A (404, igual a inexistente), nem filtra pelo bot do A, nem passa userId por query", async () => {
	const { app } = appWith("u2");
	assert.equal((await app.request("/v1/purchases/p1")).status, 404);
	assert.equal((await app.request("/v1/purchases/nao-existe")).status, 404);
	assert.equal((await app.request("/v1/purchases?botId=b1")).status, 404);
	const mine = await json(await app.request("/v1/purchases?userId=u1"));
	assert.deepEqual(mine.purchases.map((p: { id: string }) => p.id), ["p3"]);
	assert.equal((await app.request("/v1/purchases/p3")).status, 200);
});

test("filtro por bot do dono e limite validado", async () => {
	const { app, calls } = appWith("u1");
	const body = await json(await app.request("/v1/purchases?botId=b1&limit=5"));
	assert.deepEqual(body.purchases.map((p: { id: string }) => p.id), ["p1"]);
	assert.deepEqual(calls, ["list:u1:b1:5"]);
	assert.equal((await app.request("/v1/purchases?limit=0")).status, 400);
	assert.equal((await app.request("/v1/purchases?limit=abc")).status, 400);
	assert.equal((await app.request("/v1/purchases?limit=101")).status, 400);
});

test("só leitura: escrever não existe", async () => {
	const { app } = appWith("u1");
	assert.equal((await app.request("/v1/purchases", { method: "POST", body: "{}" })).status, 404);
	assert.equal((await app.request("/v1/purchases/p1", { method: "DELETE" })).status, 404);
});
