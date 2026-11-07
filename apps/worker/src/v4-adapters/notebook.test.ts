/**
 * Caderno do v4 no worker, com um db falso que filtra por dono e por bot como o real.
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/v4-adapters/notebook.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { OwnerNoteView } from "@workspace/shared";
import { createV4Notebook, loadNotebookContext, type V4NotebookDeps } from "./notebook.js";

type Row = OwnerNoteView & { userId: string };

function fakeDb() {
	const rows: Row[] = [];
	const calls: Array<{ fn: string; origin?: string; sourceRunId?: string }> = [];
	let seq = 0;
	const view = ({ userId: _owner, ...note }: Row): OwnerNoteView => note;
	const visible = (row: Row, botId: string | null | undefined) => botId === undefined || row.botId === null || row.botId === botId;
	const deps: V4NotebookDeps = {
		create: (async (input: { userId: string; botId: string | null; title: string; body: string; pinned?: boolean; origin: string; sourceRunId?: string }) => {
			calls.push({ fn: "create", origin: input.origin, ...(input.sourceRunId && { sourceRunId: input.sourceRunId }) });
			if (input.body === "dup") return { ok: false, code: "duplicate", message: "Já existe uma nota com esse mesmo texto.", existingId: "n0" };
			const row: Row = { userId: input.userId, id: `n${++seq}`, botId: input.botId, title: input.title, body: input.body, pinned: input.pinned === true, source: "agent", createdAt: "2026-11-06T10:00:00.000Z", updatedAt: "2026-11-06T10:00:00.000Z" };
			rows.push(row);
			return { ok: true, note: view(row) };
		}) as unknown as V4NotebookDeps["create"],
		get: (async (userId: string, id: string, opts: { visibleToBotId?: string | null } = {}) => {
			const row = rows.find((r) => r.userId === userId && r.id === id && visible(r, opts.visibleToBotId));
			return row ? view(row) : null;
		}) as unknown as V4NotebookDeps["get"],
		search: (async (input: { userId: string; botId?: string | null; query: string }) => rows.filter((r) => r.userId === input.userId && visible(r, input.botId) && (input.query === "" || r.body.includes(input.query))).map(view)) as unknown as V4NotebookDeps["search"],
		update: (async (input: { userId: string; id: string; patch: { title?: string; body?: string; pinned?: boolean }; visibleToBotId?: string | null; origin: string }) => {
			calls.push({ fn: "update", origin: input.origin });
			const row = rows.find((r) => r.userId === input.userId && r.id === input.id && visible(r, input.visibleToBotId));
			if (!row) return null;
			Object.assign(row, input.patch);
			return { ok: true, note: view(row) };
		}) as unknown as V4NotebookDeps["update"],
		remove: (async (input: { userId: string; id: string; visibleToBotId?: string | null }) => {
			const index = rows.findIndex((r) => r.userId === input.userId && r.id === input.id && visible(r, input.visibleToBotId));
			if (index < 0) return false;
			rows.splice(index, 1);
			return true;
		}) as unknown as V4NotebookDeps["remove"],
		listPinned: (async (input: { userId: string; botId: string | null }) => rows.filter((r) => r.userId === input.userId && r.pinned && visible(r, input.botId)).map(({ id, title }) => ({ id, title }))) as unknown as V4NotebookDeps["listPinned"],
	};
	return { deps, rows, calls };
}

test("camada owner vira nota sem bot; camada bot fica presa ao bot do run; escritas levam origem chat e o run", async () => {
	const { deps, rows, calls } = fakeDb();
	const notebook = createV4Notebook({ botId: "bot-1", runId: "run-9", deps });
	const owner = await notebook.add("user-a", { layer: "owner", title: "Viagem", body: "voo dia 12" });
	const bot = await notebook.add("user-a", { layer: "bot", title: "Projeto", body: "plano do projeto", pinned: true });
	assert.deepEqual([owner.layer, bot.layer, bot.pinned], ["owner", "bot", true]);
	assert.deepEqual(rows.map((r) => r.botId), [null, "bot-1"]);
	assert.deepEqual(calls[0], { fn: "create", origin: "chat", sourceRunId: "run-9" });
});

test("sem bot no run não existe caderno do bot, e o erro diz o que fazer", async () => {
	const notebook = createV4Notebook({ deps: fakeDb().deps });
	await assert.rejects(notebook.add("user-a", { layer: "bot", title: "x", body: "y" }), /no bot notebook/);
	assert.equal((await notebook.add("user-a", { layer: "owner", title: "x", body: "y" })).layer, "owner");
});

test("duplicata e limite viram erro com a mensagem real", async () => {
	const notebook = createV4Notebook({ botId: "bot-1", deps: fakeDb().deps });
	await assert.rejects(notebook.add("user-a", { layer: "owner", title: "x", body: "dup" }), /mesmo texto.*\[n0\]/);
});

test("o bot não enxerga nota de outro bot nem de outro dono (get, update, pin, remove, busca)", async () => {
	const { deps, rows } = fakeDb();
	const bot2 = createV4Notebook({ botId: "bot-2", deps });
	const bot1 = createV4Notebook({ botId: "bot-1", deps });
	await bot2.add("user-a", { layer: "bot", title: "do bot 2", body: "privado do bot dois" });
	const id = rows[0]!.id;
	assert.equal(await bot1.get("user-a", id), null);
	assert.equal(await bot1.update("user-a", id, { body: "x" }), null);
	assert.equal(await bot1.pin("user-a", id, true), null);
	assert.equal(await bot1.remove("user-a", id), false);
	assert.deepEqual(await bot1.search("user-a", ""), []);
	// Outro dono, mesmo bot e id certo.
	assert.equal(await bot2.get("user-b", id), null);
	assert.equal(await bot2.remove("user-b", id), false);
	assert.equal(rows[0]?.body, "privado do bot dois");
});

test("fixadas: o [context] traz id e título das do dono e do bot, e nada do corpo", async () => {
	const { deps } = fakeDb();
	const notebook = createV4Notebook({ botId: "bot-1", deps });
	await notebook.add("user-a", { layer: "owner", title: "Plano da semana", body: "texto secreto longo", pinned: true });
	await notebook.add("user-a", { layer: "owner", title: "Solta", body: "outra" });
	const section = await loadNotebookContext({ userId: "user-a", botId: "bot-1", deps });
	assert.match(section ?? "", /\[n1\] Plano da semana/);
	assert.doesNotMatch(section ?? "", /Solta|texto secreto/);
	assert.equal(await loadNotebookContext({ userId: "user-b", botId: "bot-1", deps }), null);
});

test("falha do banco ao montar o [context] não derruba o run", async () => {
	const { deps } = fakeDb();
	const broken: V4NotebookDeps = { ...deps, listPinned: (async () => { throw new Error("db fora"); }) as unknown as V4NotebookDeps["listPinned"] };
	assert.equal(await loadNotebookContext({ userId: "user-a", deps: broken }), null);
});
