import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import type { ReflectionView } from "@workspace/db";
import type { AuthEnv } from "../middleware/auth.js";
import { createReflectionRoutes, type ReflectionRouteDeps } from "./reflection.js";

const view = (over: Partial<ReflectionView>): ReflectionView => ({
	id: "r1",
	trigger: "scheduled",
	status: "done",
	summary: "Resumo",
	important: false,
	detail: null,
	createdAt: "2026-10-15T09:30:00.000Z",
	startedAt: "2026-10-15T09:30:00.000Z",
	finishedAt: "2026-10-15T09:31:00.000Z",
	changes: [{ op: "remove", botId: "b", target: "memory", id: "1", before: "x", reason: "y" }],
	stats: { tokens: 900 },
	...over,
});

function appWith(over: Partial<ReflectionRouteDeps> = {}, userId = "u1") {
	const calls: string[] = [];
	const deps: ReflectionRouteDeps = {
		loadConfig: async (id) => (calls.push(`config:${id}`), { reflection: { enabled: true, time: "06:30" }, general: { timezone: "Asia/Tokyo" } }),
		hasPrimary: async () => true,
		list: async (id, limit) => (calls.push(`list:${id}:${limit}`), [view({})]),
		enqueue: async (id) => (calls.push(`enqueue:${id}`), { ok: true, id: "q1" }),
		memoryUsage: async () => ({ used: 3100, limit: 6000 }),
		...over,
	};
	const app = new Hono<AuthEnv>();
	app.use("*", async (c, next) => {
		c.set("session", { user: { id: userId } } as AuthEnv["Variables"]["session"]);
		await next();
	});
	app.route("/", createReflectionRoutes(deps));
	return { app, calls };
}

test("GET /v1/reflection devolve horário, fuso da conta e a última execução (sem as mudanças)", async () => {
	const { app, calls } = appWith();
	const res = await app.request("/v1/reflection");
	assert.equal(res.status, 200);
	const body = await res.json();
	assert.deepEqual(body.settings, { enabled: true, time: "06:30" });
	assert.equal(body.timezone, "Asia/Tokyo");
	assert.equal(body.active, false);
	assert.equal(body.last.changeCount, 1);
	assert.equal("changes" in body.last, false);
	assert.ok(calls.includes("config:u1"));
});

test("sem configuração: desligada, horário padrão e fuso padrão", async () => {
	const { app } = appWith({ loadConfig: async () => ({}), list: async () => [] });
	const body = await (await app.request("/v1/reflection")).json();
	assert.deepEqual(body.settings, { enabled: false, time: "06:00" });
	assert.equal(body.timezone, "America/Sao_Paulo");
	assert.equal(body.last, null);
});

test("ativa quando há pedido na fila ou rodando", async () => {
	const { app } = appWith({ list: async () => [view({ id: "q", status: "queued", finishedAt: null }), view({})] });
	const body = await (await app.request("/v1/reflection")).json();
	assert.equal(body.active, true);
	assert.equal(body.last.id, "r1");
});

test("POST /v1/reflection/run enfileira para o usuário da sessão", async () => {
	const { app, calls } = appWith({}, "u9");
	const res = await app.request("/v1/reflection/run", { method: "POST" });
	assert.equal(res.status, 202);
	assert.deepEqual(calls, ["enqueue:u9"]);
});

test("run sem bot principal é 400 e já em andamento é 409", async () => {
	const none = appWith({ enqueue: async () => ({ ok: false, reason: "no-primary" }) });
	assert.equal((await none.app.request("/v1/reflection/run", { method: "POST" })).status, 400);
	const busy = appWith({ enqueue: async () => ({ ok: false, reason: "busy" }) });
	assert.equal((await busy.app.request("/v1/reflection/run", { method: "POST" })).status, 409);
});

test("histórico traz as alterações (com o texto anterior) e limita o tamanho", async () => {
	const { app, calls } = appWith();
	const body = await (await app.request("/v1/reflection/history?limit=500")).json();
	assert.equal(body.items[0].changes[0].before, "x");
	assert.ok(calls.includes("list:u1:50"));
});

test("devolve o uso da memória do bot principal e o limite em vigor", async () => {
	const { app } = appWith();
	const body = await (await app.request("/v1/reflection")).json();
	assert.deepEqual(body.memory, { limit: 6000, used: 3100 });
	const none = appWith({ memoryUsage: async () => null, loadConfig: async () => ({ reflection: { memoryChars: 12000 } }) });
	const fallback = await (await none.app.request("/v1/reflection")).json();
	assert.deepEqual(fallback.memory, { limit: 12000, used: null });
});
