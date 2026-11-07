/**
 * Rotas do caderno (F5.1) com um banco falso que filtra por dono e por bot como o real.
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/routes/notes.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import type { OwnerNoteView } from "@workspace/shared";
import type { AuthEnv } from "../middleware/auth.js";
import { createNoteRoutes, type NoteRouteDeps } from "./notes.js";

type Row = OwnerNoteView & { userId: string };

function appWith(userId = "u1") {
	const rows: Row[] = [
		{ userId: "u1", id: "n1", botId: null, title: "Viagem", body: "voo dia 12", pinned: true, source: "owner", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z" },
		{ userId: "u1", id: "n2", botId: "b1", title: "Do bot", body: "texto do bot", pinned: false, source: "agent", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z" },
	];
	const calls: string[] = [];
	const view = ({ userId: _owner, ...note }: Row): OwnerNoteView => note;
	const ownsBot = (user: string, botId: string) => user === "u1" && botId === "b1";
	const deps: NoteRouteDeps = {
		botOwned: async (user, botId) => ownsBot(user, botId),
		list: async (input) => (calls.push(`list:${input.userId}:${input.botId ?? "-"}:${input.pinnedOnly}`), rows.filter((r) => r.userId === input.userId && (!input.botId || r.botId === null || r.botId === input.botId) && (!input.pinnedOnly || r.pinned)).map(view)),
		get: async (user, id) => {
			const row = rows.find((r) => r.userId === user && r.id === id);
			return row ? view(row) : null;
		},
		create: async (input) => {
			calls.push(`create:${input.userId}:${input.botId}`);
			if (input.body === "repetido") return { ok: false, code: "duplicate", message: "Já existe uma nota com esse mesmo texto.", existingId: "n1" };
			const row: Row = { userId: input.userId, id: `n${rows.length + 1}`, botId: input.botId, title: input.title, body: input.body, pinned: input.pinned === true, source: "owner", createdAt: "2026-11-02T00:00:00.000Z", updatedAt: "2026-11-02T00:00:00.000Z" };
			rows.push(row);
			return { ok: true, note: view(row) };
		},
		update: async (input) => {
			calls.push(`update:${input.userId}:${input.id}`);
			const row = rows.find((r) => r.userId === input.userId && r.id === input.id);
			if (!row) return null;
			Object.assign(row, input.patch);
			return { ok: true, note: view(row) };
		},
		remove: async (user, id) => {
			calls.push(`remove:${user}:${id}`);
			const index = rows.findIndex((r) => r.userId === user && r.id === id);
			if (index < 0) return false;
			rows.splice(index, 1);
			return true;
		},
		changes: async (input) => (calls.push(`changes:${input.userId}:${input.botId ?? "-"}`), { changes: [], nextCursor: null }),
	};
	const app = new Hono<AuthEnv>();
	app.use("*", async (c, next) => {
		c.set("session", { user: { id: userId } } as AuthEnv["Variables"]["session"]);
		await next();
	});
	app.route("/", createNoteRoutes(deps));
	return { app, calls, rows };
}

const send = (method: string, body?: unknown) => ({ method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const json = async (response: Response) => (await response.json()) as Record<string, any>;

test("lista pelo userId da sessão, com filtro de fixadas e de bot; bot alheio é 404 sem consultar as notas", async () => {
	const { app, calls } = appWith();
	const all = await json(await app.request("/v1/notes"));
	assert.deepEqual(all.notes.map((n: OwnerNoteView) => n.id), ["n1", "n2"]);
	assert.equal(all.limit, 500);
	assert.deepEqual((await json(await app.request("/v1/notes?pinned=true"))).notes.map((n: OwnerNoteView) => n.id), ["n1"]);
	assert.equal((await app.request("/v1/notes?botId=b1")).status, 200);
	const before = calls.length;
	assert.equal((await app.request("/v1/notes?botId=b-alheio")).status, 404);
	assert.equal(calls.length, before);
});

test("criar valida o corpo (estrito), checa o bot e devolve 201; duplicata é 409 com o id existente", async () => {
	const { app, calls } = appWith();
	const created = await app.request("/v1/notes", send("POST", { title: "Lista", body: "pão e leite", pinned: true, botId: "b1" }));
	assert.equal(created.status, 201);
	assert.equal((await json(created)).note.pinned, true);
	assert.ok(calls.includes("create:u1:b1"));
	for (const bad of [{ title: "", body: "x" }, { title: "x", body: "  " }, { title: "x", body: "y", userId: "u2" }, { title: "x", body: "y".repeat(20_001) }, {}]) {
		assert.equal((await app.request("/v1/notes", send("POST", bad))).status, 400, JSON.stringify(bad).slice(0, 60));
	}
	assert.equal((await app.request("/v1/notes", send("POST", { title: "x", body: "y", botId: "b-alheio" }))).status, 404);
	const dup = await app.request("/v1/notes", send("POST", { title: "x", body: "repetido" }));
	assert.equal(dup.status, 409);
	assert.deepEqual(await json(dup), { error: "Já existe uma nota com esse mesmo texto.", code: "duplicate", existingId: "n1" });
	assert.equal((await app.request("/v1/notes", { method: "POST", body: "{", headers: { "content-type": "application/json" } })).status, 400);
});

test("editar e fixar por PATCH; corpo vazio, campo desconhecido e troca de escopo são 400", async () => {
	const { app } = appWith();
	assert.equal((await json(await app.request("/v1/notes/n2", send("PATCH", { pinned: true })))).note.pinned, true);
	assert.equal((await json(await app.request("/v1/notes/n2", send("PATCH", { title: "Novo", body: "texto novo" })))).note.title, "Novo");
	for (const bad of [{}, { botId: "b9" }, { source: "sleep" }, { pinned: "sim" }]) assert.equal((await app.request("/v1/notes/n2", send("PATCH", bad))).status, 400);
	assert.equal((await app.request("/v1/notes/n99", send("PATCH", { pinned: true }))).status, 404);
});

test("apagar devolve ok e some da lista; apagar de novo é 404", async () => {
	const { app } = appWith();
	assert.equal((await app.request("/v1/notes/n2", send("DELETE"))).status, 200);
	assert.equal((await app.request("/v1/notes/n2")).status, 404);
	assert.equal((await app.request("/v1/notes/n2", send("DELETE"))).status, 404);
});

test("IDOR: o usuário B não lista, lê, edita, fixa nem apaga a nota do A (404), e nada muda", async () => {
	const { app, rows } = appWith("u2");
	assert.deepEqual((await json(await app.request("/v1/notes"))).notes, []);
	assert.equal((await app.request("/v1/notes/n1")).status, 404);
	assert.equal((await app.request("/v1/notes/n1", send("PATCH", { body: "invadido" }))).status, 404);
	assert.equal((await app.request("/v1/notes/n1", send("PATCH", { pinned: false }))).status, 404);
	assert.equal((await app.request("/v1/notes/n1", send("DELETE"))).status, 404);
	assert.equal((await app.request("/v1/notes?botId=b1")).status, 404);
	assert.equal((await app.request("/v1/notes/changes?botId=b1")).status, 404);
	assert.equal((await app.request("/v1/notes", send("POST", { title: "x", body: "y", botId: "b1" }))).status, 404);
	assert.deepEqual(rows.map((r) => [r.id, r.body, r.pinned]), [["n1", "voo dia 12", true], ["n2", "texto do bot", false]]);
});

test("o userId do corpo ou da query nunca vale: a sessão manda", async () => {
	const { app, calls } = appWith("u2");
	await app.request("/v1/notes?userId=u1");
	assert.deepEqual(calls, ["list:u2:-:false"]);
	assert.equal((await app.request("/v1/notes", send("POST", { title: "x", body: "y", userId: "u1" }))).status, 400);
});

test("/v1/notes/changes não é lido como id de nota", async () => {
	const { app, calls } = appWith();
	const res = await app.request("/v1/notes/changes?botId=b1&limit=5");
	assert.equal(res.status, 200);
	assert.deepEqual(await json(res), { changes: [], nextCursor: null });
	assert.ok(calls.includes("changes:u1:b1"));
});
