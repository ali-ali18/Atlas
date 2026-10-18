import assert from "node:assert/strict";
import { test } from "node:test";
import { hashHookSecret } from "@workspace/db";
import type { RoutineQueue } from "@workspace/queue";
import type { EventEnvelope, RoutineRecord } from "@workspace/shared";
import { createGenericHookRoutes, type GenericHookDeps } from "./generic.js";
import { authorizeHookSecret, type MatchedHookRoutine } from "./dispatch.js";

const SECRET = "hook-secret-123";
const KEY = "hk_abc";

function makeMatch(enabled = true): MatchedHookRoutine {
	return {
		routine: { id: "routine-1", userId: "u1", botId: "b1", enabled } as RoutineRecord,
		secretHash: hashHookSecret(SECRET),
		maxBodyBytes: 65_536,
	};
}

function setup(enabled = true) {
	const calls = { match: 0, envelopes: [] as EventEnvelope[] };
	const deps: GenericHookDeps = {
		matchRoutines: async (hookKey) => {
			calls.match += 1;
			return hookKey === KEY ? [makeMatch(enabled)] : [];
		},
		enqueue: async (_queue, routines, envelope) => {
			calls.envelopes.push(envelope);
			return routines.map((row) => ({ routineId: row.routine.id, routineRunId: "run-1" }));
		},
	};
	const app = createGenericHookRoutes({} as RoutineQueue, deps);
	return { app, calls };
}

const post = (app: ReturnType<typeof setup>["app"], url: string, init: RequestInit = {}) =>
	app.request(url, { method: "POST", body: JSON.stringify({ ok: 1 }), ...init });

test("GET /v1/hooks/:key responde 405 com dica, igual para hook existente e inexistente", async () => {
	const { app, calls } = setup();
	const known = await app.request(`/v1/hooks/${KEY}`);
	const unknown = await app.request("/v1/hooks/nope");
	assert.equal(known.status, 405);
	assert.equal(unknown.status, 405);
	assert.equal(known.headers.get("allow"), "POST");
	const a = (await known.json()) as { hint: string };
	const b = await unknown.json();
	assert.deepEqual(a, b);
	assert.match(a.hint, /POST/);
	assert.match(a.hint, /X-Atlas-Hook-Secret/);
	assert.match(a.hint, /\?secret=/);
	assert.equal(calls.match, 0, "GET nunca consulta o banco");
});

test("?secret= na URL autoriza (serviços sem cabeçalho, ex.: Dokploy)", async () => {
	const { app, calls } = setup();
	const res = await post(app, `/v1/hooks/${KEY}?secret=${SECRET}`, {
		headers: { "content-type": "application/json" },
	});
	assert.equal(res.status, 202);
	assert.equal(calls.envelopes.length, 1);
});

test("?secret= errado ou ausente -> 401; hook inexistente -> 404", async () => {
	const { app } = setup();
	const json = { "content-type": "application/json" };
	assert.equal((await post(app, `/v1/hooks/${KEY}?secret=wrong`, { headers: json })).status, 401);
	assert.equal((await post(app, `/v1/hooks/${KEY}`, { headers: json })).status, 401);
	assert.equal((await post(app, `/v1/hooks/nope?secret=${SECRET}`, { headers: json })).status, 404);
});

test("cabeçalho e Bearer funcionam; basta UM dos segredos enviados valer (chave antiga no cabeçalho + nova na URL)", async () => {
	const { app } = setup();
	const json = { "content-type": "application/json" };
	const viaHeader = await post(app, `/v1/hooks/${KEY}`, {
		headers: { ...json, "X-Atlas-Hook-Secret": SECRET },
	});
	assert.equal(viaHeader.status, 202);
	const viaBearer = await post(app, `/v1/hooks/${KEY}`, {
		headers: { ...json, Authorization: `Bearer ${SECRET}` },
	});
	assert.equal(viaBearer.status, 202);
	const staleHeaderFreshUrl = await post(app, `/v1/hooks/${KEY}?secret=${SECRET}`, {
		headers: { ...json, Authorization: "Bearer chave-antiga" },
	});
	assert.equal(staleHeaderFreshUrl.status, 202);
	const allWrong = await post(app, `/v1/hooks/${KEY}?secret=errada`, {
		headers: { ...json, "X-Atlas-Hook-Secret": "wrong", Authorization: "Bearer tambem-errada" },
	});
	assert.equal(allWrong.status, 401);
});

test("corpo JSON válido é aceito mesmo com content-type fora do padrão; inválido -> 415/400", async () => {
	const { app } = setup();
	const ok = await post(app, `/v1/hooks/${KEY}?secret=${SECRET}`, {
		headers: { "content-type": "text/plain" },
	});
	assert.equal(ok.status, 202);
	const bad = await post(app, `/v1/hooks/${KEY}?secret=${SECRET}`, {
		headers: { "content-type": "text/plain" },
		body: "not json",
	});
	assert.equal(bad.status, 415);
	const badJson = await post(app, `/v1/hooks/${KEY}?secret=${SECRET}`, {
		headers: { "content-type": "application/json" },
		body: "{oops",
	});
	assert.equal(badJson.status, 400);
});

test("authorizeHookSecret segue comparando pelo hash", () => {
	assert.equal(authorizeHookSecret(SECRET, [makeMatch()]).length, 1);
	assert.equal(authorizeHookSecret("x", [makeMatch()]).length, 0);
});

test("rotina pausada: 409 com motivo só para quem tem a chave; sem chave segue 401", async () => {
	const { app, calls } = setup(false);
	const json = { "content-type": "application/json" };
	const paused = await post(app, `/v1/hooks/${KEY}?secret=${SECRET}`, { headers: json });
	assert.equal(paused.status, 409);
	assert.match(((await paused.json()) as { error: string }).error, /pausada/);
	assert.equal(calls.envelopes.length, 0, "pausada não enfileira");
	assert.equal((await post(app, `/v1/hooks/${KEY}?secret=wrong`, { headers: json })).status, 401);
});

test("?secret= segue funcionando mas avisa (Warning + marca a rotina); o cabeçalho não avisa", async () => {
	const marked: string[] = [];
	const deps: GenericHookDeps = {
		matchRoutines: async () => [makeMatch()],
		enqueue: async (_queue, routines) => routines.map((row) => ({ routineId: row.routine.id, routineRunId: "run-1" })),
		markUrlSecret: async (routineId) => void marked.push(routineId),
	};
	const app = createGenericHookRoutes({} as RoutineQueue, deps);
	const json = { "content-type": "application/json" };
	const viaUrl = await post(app, `/v1/hooks/${KEY}?secret=${SECRET}`, { headers: json });
	assert.equal(viaUrl.status, 202);
	assert.match(viaUrl.headers.get("warning") ?? "", /X-Atlas-Hook-Secret/);
	assert.deepEqual(marked, ["routine-1"]);
	const viaHeader = await post(app, `/v1/hooks/${KEY}`, { headers: { ...json, "X-Atlas-Hook-Secret": SECRET } });
	assert.equal(viaHeader.status, 202);
	assert.equal(viaHeader.headers.get("warning"), null);
	const viaBearer = await post(app, `/v1/hooks/${KEY}`, { headers: { ...json, Authorization: `Bearer ${SECRET}` } });
	assert.equal(viaBearer.status, 202);
	assert.equal(marked.length, 1);
});
