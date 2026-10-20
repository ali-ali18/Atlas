import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import type { MemoryCleanupSuggestion, MemoryCleanupView } from "@workspace/shared";
import type { AuthEnv } from "../middleware/auth.js";
import { createMemoryRoutes, type MemoryCleanupPorts, type MemoryRouteDeps } from "./memory.js";

const deleteS: MemoryCleanupSuggestion = { id: "s1", kind: "delete", target: "memory", entryIds: ["e1"], before: ["Reunião remarcada"], reason: "tarefa encerrada", createdAt: "2026-10-20T12:00:00.000Z" };
const mergeS: MemoryCleanupSuggestion = { id: "s2", kind: "merge", target: "user", entryIds: ["e2", "e3"], before: ["a", "b"], content: "a e b", reason: "repetidas", createdAt: "2026-10-20T12:00:00.000Z" };

function appWith(initial: Partial<MemoryCleanupView> = {}, over: Partial<MemoryCleanupPorts> = {}, userId = "u1") {
	const calls: string[] = [];
	let view: MemoryCleanupView = { suggestions: [deleteS, mergeS], status: null, error: null, requestedAt: null, ...initial };
	const mine = new Set(["b1"]);
	const cleanup: MemoryCleanupPorts = {
		get: async (user, botId) => (calls.push(`get:${user}:${botId}`), mine.has(botId) ? view : null),
		save: async (user, botId, list) => (calls.push(`save:${user}:${botId}:${list.map((s) => s.id).join(",") || "-"}`), (view = { ...view, suggestions: list }), view),
		enqueue: async (payload) => (calls.push(`enqueue:${payload.userId}:${payload.botId}`), true),
		removeById: (async (input: { userId: string; entryId: string; origin?: string }) => (calls.push(`remove:${input.userId}:${input.entryId}:${input.origin}`), input.entryId === "gone" ? null : { ok: true })) as never,
		merge: (async (input: { userId?: string; botId?: string; target: string; refs: string[]; content: string; origin?: string }) =>
			(calls.push(`merge:${input.userId}:${input.target}:${input.refs.length}:${input.content}:${input.origin}`), { ok: true })) as never,
		...over,
	};
	const deps = {
		botOwned: async (_user: string, botId: string) => mine.has(botId),
		cleanup,
	} as unknown as MemoryRouteDeps;
	const app = new Hono<AuthEnv>();
	app.use("*", async (c, next) => {
		c.set("session", { user: { id: userId } } as AuthEnv["Variables"]["session"]);
		await next();
	});
	app.route("/", createMemoryRoutes(deps));
	return { app, calls };
}

const post = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("GET lê as sugestões pelo dono da sessão; bot alheio é 404 e sem botId é 400", async () => {
	const { app, calls } = appWith();
	const ok = await app.request("/v1/memory/cleanup?botId=b1");
	assert.equal(ok.status, 200);
	assert.equal(((await ok.json()) as { cleanup: MemoryCleanupView }).cleanup.suggestions.length, 2);
	assert.deepEqual(calls, ["get:u1:b1"]);
	assert.equal((await app.request("/v1/memory/cleanup?botId=outro")).status, 404);
	assert.equal((await app.request("/v1/memory/cleanup")).status, 400);
});

test("POST inicia a revisão (202), não enfileira de novo enquanto revisa e recusa bot alheio", async () => {
	const { app, calls } = appWith();
	const started = await app.request("/v1/memory/cleanup", post({ botId: "b1" }));
	assert.equal(started.status, 202);
	assert.deepEqual(calls.filter((c) => c.startsWith("enqueue")), ["enqueue:u1:b1"]);
	const busy = appWith({ status: "generating", requestedAt: new Date().toISOString() });
	assert.equal((await busy.app.request("/v1/memory/cleanup", post({ botId: "b1" }))).status, 202);
	assert.deepEqual(busy.calls.filter((c) => c.startsWith("enqueue")), []);
	assert.equal((await app.request("/v1/memory/cleanup", post({ botId: "outro" }))).status, 404);
	const noQueue = appWith({}, { enqueue: async () => false });
	assert.equal((await noQueue.app.request("/v1/memory/cleanup", post({ botId: "b1" }))).status, 503);
});

test("aplicar apagar: remove a entrada como ação do usuário e tira a sugestão da lista", async () => {
	const { app, calls } = appWith();
	const res = await app.request("/v1/memory/cleanup/s1/apply", post({ botId: "b1" }));
	assert.equal(res.status, 200);
	assert.deepEqual(calls.slice(1), ["remove:u1:e1:user", "save:u1:b1:s2"]);
});

test("aplicar fundir: junta as entradas na camada da sugestão com o texto fundido", async () => {
	const { app, calls } = appWith();
	assert.equal((await app.request("/v1/memory/cleanup/s2/apply", post({ botId: "b1" }))).status, 200);
	assert.deepEqual(calls.slice(1), ["merge:u1:user:2:a e b:user", "save:u1:b1:s1"]);
});

test("sugestão que não vale mais (entrada sumiu) responde 409, sai da lista e não quebra", async () => {
	const { app, calls } = appWith({ suggestions: [{ ...deleteS, entryIds: ["gone"] }] });
	const res = await app.request("/v1/memory/cleanup/s1/apply", post({ botId: "b1" }));
	assert.equal(res.status, 409);
	assert.equal(((await res.json()) as { code: string }).code, "stale");
	assert.equal(calls.at(-1), "save:u1:b1:-");
});

test("ignorar só tira da lista (nada é apagado); id desconhecido é 404", async () => {
	const { app, calls } = appWith();
	assert.equal((await app.request("/v1/memory/cleanup/s1/dismiss", post({ botId: "b1" }))).status, 200);
	assert.deepEqual(calls.slice(1), ["save:u1:b1:s2"]);
	assert.equal((await app.request("/v1/memory/cleanup/zzz/dismiss", post({ botId: "b1" }))).status, 404);
	assert.equal((await app.request("/v1/memory/cleanup/zzz/apply", post({ botId: "b1" }))).status, 404);
});

test("aplicar todas executa cada sugestão, conta as que não valiam mais e esvazia a lista", async () => {
	const { app, calls } = appWith({ suggestions: [deleteS, { ...deleteS, id: "s9", entryIds: ["gone"] }, mergeS] });
	const res = await app.request("/v1/memory/cleanup/apply-all", post({ botId: "b1" }));
	assert.equal(res.status, 200);
	const body = (await res.json()) as { applied: number; skipped: number };
	assert.deepEqual([body.applied, body.skipped], [2, 1]);
	assert.deepEqual(calls.slice(1), ["remove:u1:e1:user", "remove:u1:gone:user", "merge:u1:user:2:a e b:user", "save:u1:b1:-"]);
});

test("nenhuma rota da limpeza grava sem a sessão do dono: bot de outro usuário nunca chega nas portas de escrita", async () => {
	const { app, calls } = appWith({}, {}, "intruso");
	for (const path of ["/v1/memory/cleanup/s1/apply", "/v1/memory/cleanup/s1/dismiss", "/v1/memory/cleanup/apply-all"]) {
		assert.equal((await app.request(path, post({ botId: "b-alheio" }))).status, 404);
	}
	assert.deepEqual(calls, []);
});
