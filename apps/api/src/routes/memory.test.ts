import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import type { MemoryChange, MemorySnapshot } from "@workspace/shared";
import type { AuthEnv } from "../middleware/auth.js";
import { createMemoryRoutes, memoryErrorMessage, type MemoryRouteDeps } from "./memory.js";

const emptyView = { entries: [], usage: { used: 0, limit: 2200 } };
const snapshot: MemorySnapshot = { user: emptyView, memory: emptyView };

const change = (over: Partial<MemoryChange> = {}): MemoryChange => ({
	id: "c1",
	botId: "b1",
	entryId: "e1",
	target: "memory",
	action: "replace",
	before: "a",
	after: "b",
	source: "chat",
	undoOfId: null,
	createdAt: "2026-10-15T10:00:00.000Z",
	undoneAt: null,
	...over,
});

/** `mine` = ids que pertencem ao usuário logado; qualquer outro id é "de outro usuário". */
function appWith(over: Partial<MemoryRouteDeps> = {}, userId = "u1") {
	const calls: string[] = [];
	const mine = { bots: new Set(["b1"]), entries: new Set(["e1"]), changes: new Set(["c1"]) };
	const deps: MemoryRouteDeps = {
		botOwned: async (_user, botId) => mine.bots.has(botId),
		snapshot: async (user, botId) => (calls.push(`snapshot:${user}:${botId ?? "-"}`), snapshot),
		add: async (input) => (calls.push(`add:${input.userId}:${input.target}:${input.botId ?? "-"}:${input.source}:${input.origin}`), { ok: true, entry: { id: "n1", target: input.target, content: input.content, createdAt: "", updatedAt: "" } }),
		replace: async (input) => (calls.push(`replace:${input.origin}`), { ok: true }),
		remove: async (input) => (calls.push(`remove:${input.origin}`), { ok: true }),
		editById: async (input) => (calls.push(`edit:${input.userId}:${input.entryId}:${input.origin}`), mine.entries.has(input.entryId) ? { ok: true, entry: { id: input.entryId, target: "user", content: input.content, createdAt: "", updatedAt: "" } } : null),
		removeById: async (input) => (calls.push(`delete:${input.userId}:${input.entryId}:${input.origin}`), mine.entries.has(input.entryId) ? { ok: true } : null),
		listChanges: async (input) => (calls.push(`changes:${input.userId}:${input.botId ?? "-"}:${input.cursor ?? "-"}:${input.limit ?? "-"}`), { changes: [change()], nextCursor: "c1" }),
		undo: async (input) =>
			mine.changes.has(input.changeId)
				? { ok: true, change: change({ id: "u9", undoOfId: input.changeId, source: "user" }) }
				: { ok: false, code: "not_found", message: "Mudança não encontrada." },
		...over,
	};
	const app = new Hono<AuthEnv>();
	app.use("*", async (c, next) => {
		c.set("session", { user: { id: userId } } as AuthEnv["Variables"]["session"]);
		await next();
	});
	app.route("/", createMemoryRoutes(deps));
	return { app, calls };
}

const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const patch = (body: unknown) => ({ ...json(body), method: "PATCH" });

test("GET /v1/memory lista pelo userId da sessão; bot de outro usuário é 404", async () => {
	const { app, calls } = appWith();
	assert.equal((await app.request("/v1/memory?botId=b1")).status, 200);
	assert.deepEqual(calls, ["snapshot:u1:b1"]);
	const foreign = await app.request("/v1/memory?botId=b-alheio");
	assert.equal(foreign.status, 404);
	assert.equal(calls.length, 1, "não consultou o banco para o bot alheio");
});

test("POST /v1/memory: grava como usuário (source/origin user); memory exige botId do dono", async () => {
	const { app, calls } = appWith();
	const ok = await app.request("/v1/memory", json({ target: "memory", content: " lembrar disso ", botId: "b1" }));
	assert.equal(ok.status, 200);
	assert.deepEqual(calls, ["add:u1:memory:b1:user:user"]);
	assert.equal((await app.request("/v1/memory", json({ target: "memory", content: "x" }))).status, 400);
	assert.equal((await app.request("/v1/memory", json({ target: "memory", content: "x", botId: "b-alheio" }))).status, 404);
	assert.equal((await app.request("/v1/memory", json({ target: "user", content: "perfil" }))).status, 200);
	assert.equal((await app.request("/v1/memory", json({ target: "user", content: "  " }))).status, 400);
});

test("POST /v1/memory: duplicado vira 409 com mensagem em pt-BR", async () => {
	const { app } = appWith({ add: async () => ({ ok: false, error: "duplicado", currentEntries: [], usage: "0/1" }) });
	const res = await app.request("/v1/memory", json({ target: "user", content: "x" }));
	assert.equal(res.status, 409);
	const body = await res.json();
	assert.equal(body.error, "Essa memória já existe.");
	assert.equal(body.code, "duplicado");
});

test("PATCH/DELETE por id: id de outro usuário é 404, o seu passa com origin user", async () => {
	const { app, calls } = appWith();
	assert.equal((await app.request("/v1/memory/entries/e-alheia", patch({ content: "invadido" }))).status, 404);
	assert.equal((await app.request("/v1/memory/entries/e-alheia", { method: "DELETE" })).status, 404);
	const edited = await app.request("/v1/memory/entries/e1", patch({ content: "novo texto" }));
	assert.equal(edited.status, 200);
	assert.equal((await edited.json()).entry.content, "novo texto");
	assert.equal((await app.request("/v1/memory/entries/e1", { method: "DELETE" })).status, 200);
	assert.ok(calls.includes("edit:u1:e1:user"));
	assert.ok(calls.includes("delete:u1:e1:user"));
	assert.equal((await app.request("/v1/memory/entries/e1", patch({ content: "  " }))).status, 400);
	assert.equal((await app.request("/v1/memory/entries/e1", patch({}))).status, 400);
});

test("PATCH por id: limite excedido vira 400 com mensagem em pt-BR", async () => {
	const { app } = appWith({ editById: async () => ({ ok: false, error: "limite de 2200 caracteres excedido", currentEntries: [], usage: "" }) });
	const res = await app.request("/v1/memory/entries/e1", patch({ content: "x" }));
	assert.equal(res.status, 400);
	assert.match((await res.json()).error, /memória está cheia/);
});

test("GET /v1/memory/changes: escopo pelo usuário, cursor e limite repassados; bot alheio 404", async () => {
	const { app, calls } = appWith();
	const res = await app.request("/v1/memory/changes?botId=b1&cursor=c0&limit=10");
	assert.equal(res.status, 200);
	const body = await res.json();
	assert.equal(body.changes.length, 1);
	assert.equal(body.nextCursor, "c1");
	assert.deepEqual(calls, ["changes:u1:b1:c0:10"]);
	assert.equal((await app.request("/v1/memory/changes?botId=b-alheio")).status, 404);
});

test("POST undo: seu id desfaz (200); id de outro usuário é 404", async () => {
	const { app } = appWith();
	const ok = await app.request("/v1/memory/changes/c1/undo", { method: "POST" });
	assert.equal(ok.status, 200);
	assert.equal((await ok.json()).change.undoOfId, "c1");
	const foreign = await app.request("/v1/memory/changes/c-alheia/undo", { method: "POST" });
	assert.equal(foreign.status, 404);
});

test("POST undo: entrada alterada depois vira 409 com a mensagem clara", async () => {
	const message = "Não deu para desfazer: essa memória foi alterada depois. Edite ou apague direto na lista.";
	const { app } = appWith({ undo: async () => ({ ok: false, code: "stale", message }) });
	const res = await app.request("/v1/memory/changes/c1/undo", { method: "POST" });
	assert.equal(res.status, 409);
	const body = await res.json();
	assert.equal(body.code, "stale");
	assert.equal(body.message, message);
});

test("rotas legadas por oldText gravam origem user", async () => {
	const { app, calls } = appWith();
	await app.request("/v1/memory", patch({ target: "user", oldText: "a", content: "b" }));
	await app.request("/v1/memory", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ target: "user", oldText: "b" }) });
	assert.deepEqual(calls, ["replace:user", "remove:user"]);
});

test("memoryErrorMessage cobre os erros conhecidos", () => {
	assert.equal(memoryErrorMessage("conteúdo vazio"), "Escreva algo antes de salvar.");
	assert.match(memoryErrorMessage("conteúdo bloqueado pela verificação de segurança"), /bloqueado/);
	assert.match(memoryErrorMessage("qualquer outro"), /Não foi possível/);
});
