import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import type { LessonView } from "@workspace/shared";
import type { AuthEnv } from "../middleware/auth.js";
import { createLessonRoutes, type LessonRouteDeps } from "./lessons.js";

const lesson = (over: Partial<LessonView> = {}): LessonView => ({
	id: "l1", ref: "Ll1", scope: "bot", scopeKey: null, content: "Ao X, faça Y — porque Z", origin: "correction", evidence: null, rule: null, helpful: 0, harmful: 0, uses: 0,
	status: "active", version: 1, supersedesId: null, canRestore: false, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", lastUsedAt: null, ...over,
});

/** `mine` = o que pertence ao usuário logado (u1); o resto é "de outro usuário". */
function appWith(userId = "u1") {
	const calls: string[] = [];
	const mine = { bots: new Set(["b1"]), lessons: new Set(["l1"]) };
	const owns = (user: string) => user === "u1";
	const deps: LessonRouteDeps = {
		botOwned: async (user, botId) => owns(user) && mine.bots.has(botId),
		list: async (user, botId) => (calls.push(`list:${user}:${botId}`), [lesson()]),
		edit: async (user, id, content) => (calls.push(`edit:${user}:${id}:${content}`), owns(user) && mine.lessons.has(id) ? lesson({ id, content, version: 2, canRestore: true }) : null),
		retire: async (user, id) => (calls.push(`retire:${user}:${id}`), owns(user) && mine.lessons.has(id) ? lesson({ id, status: "retired" }) : null),
		restore: async (user, id) => (calls.push(`restore:${user}:${id}`), owns(user) && mine.lessons.has(id) ? lesson({ id }) : null),
		setRule: async (user, id, rule) => (calls.push(`rule:${user}:${id}:${rule ? rule.kind : "none"}`), owns(user) && mine.lessons.has(id) ? lesson({ id, rule }) : null),
	};
	const app = new Hono<AuthEnv>();
	app.use("*", async (c, next) => {
		c.set("session", { user: { id: userId } } as AuthEnv["Variables"]["session"]);
		await next();
	});
	app.route("/", createLessonRoutes(deps));
	return { app, calls };
}

const send = (method: string, body?: unknown) => ({ method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

test("GET /v1/lessons lista pelo userId da sessão; sem botId é 400; bot de outro usuário é 404 sem consultar o banco", async () => {
	const { app, calls } = appWith();
	const ok = await app.request("/v1/lessons?botId=b1");
	assert.equal(ok.status, 200);
	assert.equal(((await ok.json()) as { lessons: unknown[] }).lessons.length, 1);
	assert.deepEqual(calls, ["list:u1:b1"]);
	assert.equal((await app.request("/v1/lessons")).status, 400);
	assert.equal((await app.request("/v1/lessons?botId=b-alheio")).status, 404);
	assert.equal(calls.length, 1);
});

test("usuário B não lista, edita, apaga nem restaura a lição do usuário A (404)", async () => {
	const { app } = appWith("u2");
	assert.equal((await app.request("/v1/lessons?botId=b1")).status, 404);
	assert.equal((await app.request("/v1/lessons/l1", send("PATCH", { content: "hack" }))).status, 404);
	assert.equal((await app.request("/v1/lessons/l1", send("DELETE"))).status, 404);
	assert.equal((await app.request("/v1/lessons/l1/restore", send("POST"))).status, 404);
});

test("PATCH valida o texto (vazio e acima de 280) e usa o userId da sessão, nunca o do corpo", async () => {
	const { app, calls } = appWith();
	assert.equal((await app.request("/v1/lessons/l1", send("PATCH", { content: "   " }))).status, 400);
	assert.equal((await app.request("/v1/lessons/l1", send("PATCH", { content: "x".repeat(281) }))).status, 400);
	assert.equal((await app.request("/v1/lessons/l1", send("PATCH", {}))).status, 400);
	const ok = await app.request("/v1/lessons/l1", send("PATCH", { content: "  Novo  texto ", userId: "u2" }));
	assert.equal(ok.status, 200);
	assert.deepEqual(calls, ["edit:u1:l1:Novo texto"]);
	assert.equal(((await ok.json()) as { lesson: LessonView }).lesson.canRestore, true);
});

test("DELETE aposenta e POST /restore devolve a versão anterior; sem lição é 404", async () => {
	const { app, calls } = appWith();
	const del = await app.request("/v1/lessons/l1", send("DELETE"));
	assert.equal(((await del.json()) as { lesson: LessonView }).lesson.status, "retired");
	assert.equal((await app.request("/v1/lessons/l1/restore", send("POST"))).status, 200);
	assert.equal((await app.request("/v1/lessons/zzz", send("DELETE"))).status, 404);
	assert.deepEqual(calls.slice(0, 2), ["retire:u1:l1", "restore:u1:l1"]);
});

test("PUT /rule grava so regras que apertam (estritas) e usa o userId da sessao; DELETE tira a regra; outro usuario recebe 404", async () => {
	const { app, calls } = appWith();
	const ok = await app.request("/v1/lessons/l1/rule", send("PUT", { rule: { kind: "required_args", tool: "mcp__erp__create_order", fields: ["customer.id"], note: "cliente obrigatorio" } }));
	assert.equal(ok.status, 200);
	assert.equal(((await ok.json()) as { lesson: LessonView }).lesson.rule?.kind, "required_args");
	// Regras que relaxam, trocam destino ou pulam checagem sao recusadas com o motivo.
	for (const rule of [
		{ kind: "auto_approve", tool: "mcp__erp__create_order" },
		{ kind: "confirm_always", tool: "mcp__erp__create_order", mode: "allow" },
		{ kind: "required_args", tool: "mcp__erp__create_order", fields: ["to"], recipient: "x@y.com" },
		{ kind: "require_prior_call", tool: "mcp__erp__create_order", requires: "mcp__erp__create_order", within: "run" },
		{ kind: "require_prior_call", tool: "mcp__erp__create_order", requires: "mcp__erp__list", within: "forever" },
		{ kind: "required_args", tool: "*", fields: ["a"] },
	]) {
		const res = await app.request("/v1/lessons/l1/rule", send("PUT", { rule }));
		assert.equal(res.status, 400, JSON.stringify(rule));
		assert.ok(((await res.json()) as { error: string }).error.length > 0);
	}
	assert.equal((await app.request("/v1/lessons/l1/rule", send("PUT", {}))).status, 400);
	const cleared = await app.request("/v1/lessons/l1/rule", send("DELETE"));
	assert.equal(cleared.status, 200);
	assert.equal(((await cleared.json()) as { lesson: LessonView }).lesson.rule, null);
	assert.deepEqual(calls, ["rule:u1:l1:required_args", "rule:u1:l1:none"]);
	const other = appWith("u2");
	assert.equal((await other.app.request("/v1/lessons/l1/rule", send("PUT", { rule: { kind: "confirm_always", tool: "mcp__erp__create_order" } }))).status, 404);
});
