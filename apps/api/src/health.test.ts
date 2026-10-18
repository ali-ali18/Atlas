import assert from "node:assert/strict";
import { test } from "node:test";
import { createHealthRoutes } from "./health.js";

const ok = async () => 1;
const boom = async () => {
	throw new Error("conexão recusada com segredo");
};

test("/health continua sendo liveness simples", async () => {
	const app = createHealthRoutes({ checkDb: boom, checkRedis: boom });
	const res = await app.request("/health");
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), { ok: true });
});

test("/health/ready: 200 com Postgres e Redis respondendo", async () => {
	const app = createHealthRoutes({ checkDb: ok, checkRedis: ok });
	const res = await app.request("/health/ready");
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), { ok: true, checks: { db: "ok", redis: "ok" } });
});

test("/health/ready: 503 quando o Postgres falha, sem vazar a mensagem do erro", async () => {
	const app = createHealthRoutes({ checkDb: boom, checkRedis: ok });
	const res = await app.request("/health/ready");
	assert.equal(res.status, 503);
	const text = await res.text();
	assert.deepEqual(JSON.parse(text), { ok: false, checks: { db: "fail", redis: "ok" } });
	assert.ok(!text.includes("segredo"));
});

test("/health/ready: 503 quando o Redis falha ou não existe", async () => {
	assert.equal((await createHealthRoutes({ checkDb: ok, checkRedis: boom }).request("/health/ready")).status, 503);
	assert.equal((await createHealthRoutes({ checkDb: ok }).request("/health/ready")).status, 503);
});

test("/health/ready: dependência pendurada estoura o timeout em vez de travar o healthcheck", async () => {
	const hang = () => new Promise<never>(() => undefined);
	const app = createHealthRoutes({ checkDb: ok, checkRedis: hang, timeoutMs: 20 });
	const res = await app.request("/health/ready");
	assert.equal(res.status, 503);
	assert.deepEqual((await res.json() as { checks: unknown }).checks, { db: "ok", redis: "fail" });
});

test("/health/ready: durante o shutdown responde 503 sem consultar nada", async () => {
	let called = 0;
	const app = createHealthRoutes({ checkDb: async () => void (called += 1), checkRedis: ok, isShuttingDown: () => true });
	const res = await app.request("/health/ready");
	assert.equal(res.status, 503);
	assert.equal(called, 0);
});
