import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import type { AuthEnv } from "../middleware/auth.js";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";

const { prisma } = await import("@workspace/db");
const { FakeTable, installFakes } = await import("@workspace/db/testing");
const { createPushRoutes } = await import("./push.js");

const USER_A = "user-a-ficticio";
const USER_B = "user-b-ficticio";
const vapid = { publicKey: "pub", privateKey: "priv", subject: "mailto:a@b.c" };
const sub = (endpoint: string) => ({ endpoint, keys: { p256dh: "pk", auth: "au" } });

function appFor(userId: string, deps: Partial<Parameters<typeof createPushRoutes>[0]> = {}) {
	const outer = new Hono<AuthEnv>();
	outer.use("*", async (c, next) => {
		c.set("session", { user: { id: userId } } as AuthEnv["Variables"]["session"]);
		await next();
	});
	outer.route("/", createPushRoutes({ vapid, sender: { send: async () => ({ ok: true }) }, presence: null, ...deps }));
	return outer;
}

const post = (app: Hono<AuthEnv>, path: string, body: unknown, method = "POST") =>
	app.request(path, { method, headers: { "Content-Type": "application/json", "user-agent": "Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile Safari/537.36" }, body: JSON.stringify(body) });

test("inscrever, listar, remover: cada usuário só vê e apaga os seus aparelhos", async () => {
	const subs = new FakeTable([], () => ({ createdAt: new Date(), lastUsedAt: new Date(), failureCount: 0, lastFailureAt: null, lastError: null }));
	const installed = installFakes({ pushSubscription: subs });
	try {
		assert.equal((await post(appFor(USER_A), "/v1/push/subscriptions", { endpoint: "http://inseguro", keys: {} })).status, 400);
		const created = await post(appFor(USER_A), "/v1/push/subscriptions", sub("https://push.example/a"));
		assert.equal(created.status, 201);
		const { id, label } = (await created.json()) as { id: string; label: string };
		assert.equal(label, "Chrome · Android");
		await post(appFor(USER_A), "/v1/push/subscriptions", sub("https://push.example/a"));
		assert.equal(subs.rows.length, 1);
		const list = (await (await appFor(USER_A).request("/v1/push/subscriptions")).json()) as { devices: Array<{ id: string }> };
		assert.equal(list.devices.length, 1);
		assert.equal(((await (await appFor(USER_B).request("/v1/push/subscriptions")).json()) as { devices: unknown[] }).devices.length, 0);
		assert.equal((await appFor(USER_B).request(`/v1/push/subscriptions/${id}`, { method: "DELETE" })).status, 404);
		assert.equal((await appFor(USER_A).request(`/v1/push/subscriptions/${id}`, { method: "DELETE" })).status, 200);
		assert.equal(subs.rows.length, 0);
		await post(appFor(USER_A), "/v1/push/subscriptions", sub("https://push.example/b"));
		assert.equal((await post(appFor(USER_A), "/v1/push/unsubscribe", { endpoint: "https://push.example/b" })).status, 200);
		assert.equal(subs.rows.length, 0);
	} finally {
		installed.restore();
	}
});

test("sem chaves VAPID: config desligada e inscrição recusada", async () => {
	const app = appFor(USER_A, { vapid: null, sender: null });
	assert.deepEqual(await (await app.request("/v1/push/config")).json(), { enabled: false, publicKey: null });
	assert.equal((await post(app, "/v1/push/subscriptions", sub("https://push.example/a"))).status, 503);
	assert.equal((await post(app, "/v1/push/test", {})).status, 503);
});

test("testar: manda para os aparelhos e apaga o que o serviço de push diz que morreu (410)", async () => {
	const subs = new FakeTable([], () => ({ createdAt: new Date(), lastUsedAt: new Date(), failureCount: 0, lastFailureAt: null, lastError: null }));
	const installed = installFakes({ pushSubscription: subs });
	const sent: string[] = [];
	const sender = { send: async (target: { endpoint: string }) => (sent.push(target.endpoint), target.endpoint.endsWith("/dead") ? ({ ok: false, status: 410, error: "Gone" } as const) : ({ ok: true } as const)) };
	try {
		assert.equal((await post(appFor(USER_A, { sender }), "/v1/push/test", {})).status, 409);
		await post(appFor(USER_A), "/v1/push/subscriptions", sub("https://push.example/live"));
		await post(appFor(USER_A), "/v1/push/subscriptions", sub("https://push.example/dead"));
		const result = (await (await post(appFor(USER_A, { sender }), "/v1/push/test", {})).json()) as { sent: number; deleted: number };
		assert.deepEqual([result.sent, result.deleted], [1, 1]);
		assert.deepEqual(subs.rows.map((row) => row.endpoint), ["https://push.example/live"]);
	} finally {
		installed.restore();
	}
});

test("viewing: só o dono da conversa; sinal e fim chegam à presença", async () => {
	const calls: string[] = [];
	const presence = {
		touch: async (u: string, c: string, client: string) => void calls.push(`touch:${u}:${c}:${client}`),
		clear: async (u: string, c: string, client: string) => void calls.push(`clear:${u}:${c}:${client}`),
		isViewed: async () => false,
	};
	const original = prisma.conversation.findFirst;
	prisma.conversation.findFirst = (async (args: { where: { id: string; userId: string } }) =>
		args.where.id === "conv-a" && args.where.userId === USER_A ? { id: "conv-a" } : null) as unknown as typeof prisma.conversation.findFirst;
	try {
		assert.equal((await post(appFor(USER_B, { presence }), "/v1/conversations/conv-a/viewing", { clientId: "t1", viewing: true })).status, 404);
		assert.equal((await post(appFor(USER_A, { presence }), "/v1/conversations/conv-a/viewing", { clientId: "", viewing: true })).status, 400);
		assert.equal((await post(appFor(USER_A, { presence, now: () => 5 }), "/v1/conversations/conv-a/viewing", { clientId: "t1", viewing: true })).status, 200);
		assert.equal((await post(appFor(USER_A, { presence }), "/v1/conversations/conv-a/viewing", { clientId: "t1", viewing: false })).status, 200);
		assert.deepEqual(calls, [`touch:${USER_A}:conv-a:t1`, `clear:${USER_A}:conv-a:t1`]);
	} finally {
		prisma.conversation.findFirst = original;
	}
});
