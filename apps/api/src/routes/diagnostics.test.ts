import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import type { AuthEnv } from "../middleware/auth.js";
import { createDiagnosticsRoutes, type DiagnosticsDeps } from "./diagnostics.js";

const SECRET = "sk-or-v1-SUPERSECRETVALUE123456";

function deps(over: Partial<DiagnosticsDeps> = {}): DiagnosticsDeps {
	return {
		env: { OPENROUTER_API_KEY: SECRET, ATLAS_COMMIT: "abc1234" },
		now: () => new Date("2026-10-15T12:00:00.000Z"),
		build: { service: "api", version: "0.1.0-beta", commit: "abc1234", commitShort: "abc1234", startedAt: "2026-10-15T11:00:00.000Z" },
		isOwner: (email) => email === "owner@example.com",
		pingDb: async () => ({ ok: true, ms: 3 }),
		pingRedis: async () => ({ ok: true, ms: 1 }),
		queues: async () => [{ name: "agent-runs", waiting: 0, active: 1, delayed: 0, failed: 2 }],
		worker: async () => ({ version: "0.1.0-beta", commit: "abc1234", commitShort: "abc1234", startedAt: "2026-10-15T11:00:05.000Z", beatAt: "2026-10-15T11:59:50.000Z" }),
		pushSubscriptions: async () => 2,
		accountProviders: async () => [
			{ id: "anthropic", label: "Anthropic", present: true },
			{ id: "composio", label: "Composio", present: false },
		],
		failures: async () => [{ kind: "run", id: "r1", label: "rodar teste", reason: `falhou com ${SECRET}`, at: "2026-10-15T11:30:00.000Z" }],
		sentryEnabled: () => false,
		...over,
	};
}

function appFor(email: string, d: DiagnosticsDeps) {
	const app = new Hono<AuthEnv>();
	app.use("*", async (c, next) => {
		c.set("session", { user: { id: "u1", email } } as never);
		await next();
	});
	app.route("/", createDiagnosticsRoutes(d));
	return app;
}

test("só o dono lê o diagnóstico", async () => {
	const res = await appFor("intruso@example.com", deps()).request("/v1/diagnostics");
	assert.equal(res.status, 403);
});

test("mostra versões, saúde, push, provedores (sim/não) e falhas, sem valores de chaves", async () => {
	const res = await appFor("owner@example.com", deps()).request("/v1/diagnostics");
	assert.equal(res.status, 200);
	const body = await res.json();
	assert.equal(body.api.commit, "abc1234");
	assert.equal(body.api.version, "0.1.0-beta");
	assert.equal(body.worker.version, "0.1.0-beta");
	assert.equal(body.api.uptimeSec, 3600);
	assert.equal(body.worker.up, true);
	assert.equal(body.worker.commitShort, "abc1234");
	assert.deepEqual(body.services.postgres, { ok: true, ms: 3 });
	assert.equal(body.services.queues[0].failed, 2);
	assert.equal(body.push.enabled, false);
	assert.ok(body.push.problems.length > 0);
	assert.equal(body.push.subscriptions, 2);
	const openrouter = body.providers.find((p: { id: string }) => p.id === "openrouter");
	assert.deepEqual(openrouter, { id: "openrouter", label: "OpenRouter", present: true, source: "server" });
	assert.equal(body.providers.find((p: { id: string }) => p.id === "composio").present, false);
	assert.equal(body.failures[0].kind, "run");
	assert.ok(!JSON.stringify(body).includes("SUPERSECRETVALUE"), "nenhum valor de chave sai na resposta");
});

test("serviço fora do ar aparece como fora, não derruba o diagnóstico", async () => {
	const res = await appFor("owner@example.com", deps({
		pingDb: async () => { throw new Error("db off"); },
		pingRedis: async () => ({ ok: false, ms: null, error: "ECONNREFUSED" }),
		queues: async () => { throw new Error("redis off"); },
		worker: async () => null,
		failures: async () => { throw new Error("x"); },
	})).request("/v1/diagnostics");
	assert.equal(res.status, 200);
	const body = await res.json();
	assert.equal(body.services.postgres.ok, false);
	assert.equal(body.services.redis.ok, false);
	assert.equal(body.services.queues, null);
	assert.equal(body.worker.up, false);
	assert.deepEqual(body.failures, []);
});

test("tarefas em segundo plano: último sucesso e erro, com o erro limpo de segredos", async () => {
	const res = await appFor(
		"owner@example.com",
		deps({
			maintenance: async () => [
				{ kind: "summary", lastSuccessAt: "2026-10-15T10:00:00.000Z", lastError: null },
				{ kind: "memory-review", lastSuccessAt: null, lastError: { message: `chave ${SECRET} recusada`, at: "2026-10-15T11:00:00.000Z" } },
			],
		}),
	).request("/v1/diagnostics");
	const body = await res.json();
	assert.equal(body.maintenance.length, 2);
	assert.equal(body.maintenance[0].lastSuccessAt, "2026-10-15T10:00:00.000Z");
	assert.equal(body.maintenance[1].lastError.at, "2026-10-15T11:00:00.000Z");
	assert.ok(!JSON.stringify(body).includes(SECRET));
});

test("sem a dependência, a lista de tarefas vem vazia e o resto continua", async () => {
	const res = await appFor("owner@example.com", deps()).request("/v1/diagnostics");
	assert.deepEqual((await res.json()).maintenance, []);
});
