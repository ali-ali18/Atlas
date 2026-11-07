/**
 * Caderno do dono contra Postgres real (F5.1): CRUD, escopo por dono e por bot, histórico e desfazer.
 * Pulado sem ATLAS_TEST_DB_URL. Runner: `pnpm --filter @workspace/db test:db`.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { OWNER_NOTES_MAX_PER_OWNER } from "@workspace/shared";
import { prisma } from "./client.js";
import { createNote, deleteNote, getNote, listNoteChanges, listNotes, listPinnedNotes, listSleepChanges, searchNotes, updateNote } from "./notes.js";
import { undoMemoryChange } from "./memory-undo.js";
import { createTestBot, createTestUser, dbSkip } from "./testing/test-db.js";

describe("caderno (Postgres real)", { skip: dbSkip }, () => {
	let userA: string;
	let userB: string;
	let bot1: string;
	let bot2: string;

	before(async () => {
		userA = (await createTestUser("note-a")).id;
		userB = (await createTestUser("note-b")).id;
		bot1 = (await createTestBot(userA, { name: "um" })).id;
		bot2 = (await createTestBot(userA, { name: "dois" })).id;
	});
	after(async () => {
		await prisma.$disconnect();
	});

	const make = async (over: Partial<Parameters<typeof createNote>[0]> = {}) => {
		const result = await createNote({ userId: userA, botId: null, title: "Título", body: `corpo ${Math.random()}`, origin: "user", ...over });
		assert.ok(result.ok, JSON.stringify(result));
		return result.note;
	};
	const lastChange = async (entryId: string) => (await prisma.memoryChange.findMany({ where: { entryId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1 }))[0]!;

	test("criar grava a nota e o histórico (alvo note, origem e relatório)", async () => {
		const note = await make({ title: "Viagem", body: "voo dia 12", pinned: true, origin: "sleep", reportId: "rep-1" });
		assert.equal(note.source, "sleep");
		assert.equal(note.pinned, true);
		const change = await lastChange(note.id);
		assert.deepEqual([change.target, change.action, change.source, change.after, change.reportId], ["note", "add", "sleep", "voo dia 12", "rep-1"]);
		assert.deepEqual(change.afterMeta, { title: "Viagem", pinned: true });
	});

	test("duplicata no mesmo escopo é recusada; em outro escopo ou outro dono, não", async () => {
		const first = await make({ body: "Prefiro reuniões às 10h" });
		const again = await createNote({ userId: userA, botId: null, title: "outra", body: "prefiro REUNIOES as 10h!", origin: "chat" });
		assert.deepEqual([again.ok, !again.ok && again.code, !again.ok && again.existingId], [false, "duplicate", first.id]);
		assert.ok((await createNote({ userId: userA, botId: bot1, title: "do bot", body: "Prefiro reuniões às 10h", origin: "chat" })).ok);
		assert.ok((await createNote({ userId: userB, botId: null, title: "de B", body: "Prefiro reuniões às 10h", origin: "user" })).ok);
	});

	test("visibilidade: o bot vê as notas do dono e as suas, não as de outro bot; a UI vê todas", async () => {
		const owner = await make({ body: "nota do dono visível" });
		const mine = await make({ botId: bot1, body: "nota do bot um" });
		const theirs = await make({ botId: bot2, body: "nota do bot dois" });
		const ids = async (botId?: string | null) => new Set((await listNotes({ userId: userA, botId })).map((n) => n.id));
		const seenByBot1 = await ids(bot1);
		assert.ok(seenByBot1.has(owner.id) && seenByBot1.has(mine.id) && !seenByBot1.has(theirs.id));
		const all = await ids();
		assert.ok(all.has(owner.id) && all.has(mine.id) && all.has(theirs.id));
		assert.equal(await getNote(userA, theirs.id, { visibleToBotId: bot1 }), null);
		assert.ok(await getNote(userA, theirs.id));
	});

	test("IDOR: o outro dono não lê, lista, busca, edita, fixa nem apaga", async () => {
		const note = await make({ title: "segredo do A", body: "conteúdo privado do A", pinned: true });
		assert.equal(await getNote(userB, note.id), null);
		assert.ok(!(await listNotes({ userId: userB })).some((n) => n.id === note.id));
		assert.deepEqual(await searchNotes({ userId: userB, query: "privado" }), []);
		assert.ok(!(await listPinnedNotes({ userId: userB, botId: null })).some((n) => n.id === note.id));
		assert.equal(await updateNote({ userId: userB, id: note.id, patch: { body: "invadido" }, origin: "user" }), null);
		assert.equal(await updateNote({ userId: userB, id: note.id, patch: { pinned: false }, origin: "user" }), null);
		assert.equal(await deleteNote({ userId: userB, id: note.id, origin: "user" }), false);
		const intact = await getNote(userA, note.id);
		assert.deepEqual([intact?.body, intact?.pinned], ["conteúdo privado do A", true]);
		const undoByB = await undoMemoryChange({ userId: userB, changeId: (await lastChange(note.id)).id });
		assert.deepEqual([undoByB.ok, !undoByB.ok && undoByB.code], [false, "not_found"]);
		assert.ok(!(await listNoteChanges({ userId: userB })).changes.some((c) => c.entryId === note.id));
	});

	test("editar, fixar e histórico com antes/depois; sem mudança real não grava", async () => {
		const note = await make({ title: "Antes", body: "texto antes" });
		const edited = await updateNote({ userId: userA, id: note.id, patch: { title: "Depois", body: "texto depois" }, origin: "chat" });
		assert.ok(edited?.ok);
		let change = await lastChange(note.id);
		assert.deepEqual([change.action, change.source, change.before, change.after, change.beforeMeta, change.afterMeta], ["replace", "chat", "texto antes", "texto depois", { title: "Antes", pinned: false }, { title: "Depois", pinned: false }]);
		const pinned = await updateNote({ userId: userA, id: note.id, patch: { pinned: true }, origin: "user" });
		assert.ok(pinned?.ok && pinned.note.pinned);
		const before = await prisma.memoryChange.count({ where: { entryId: note.id } });
		await updateNote({ userId: userA, id: note.id, patch: { pinned: true, title: "Depois" }, origin: "user" });
		assert.equal(await prisma.memoryChange.count({ where: { entryId: note.id } }), before);
		change = await lastChange(note.id);
		assert.equal(change.afterMeta && (change.afterMeta as { pinned: boolean }).pinned, true);
	});

	test("editar para o texto de outra nota do mesmo escopo é recusado", async () => {
		const a = await make({ body: "texto único alfa" });
		const b = await make({ body: "texto único beta" });
		const result = await updateNote({ userId: userA, id: b.id, patch: { body: "Texto unico ALFA" }, origin: "user" });
		assert.deepEqual([result?.ok, result && !result.ok && result.code, result && !result.ok && result.existingId], [false, "duplicate", a.id]);
	});

	test("o bot só edita e apaga o que ele enxerga", async () => {
		const theirs = await make({ botId: bot2, body: "do bot dois, intocável pelo um" });
		assert.equal(await updateNote({ userId: userA, id: theirs.id, patch: { body: "x" }, origin: "chat", visibleToBotId: bot1 }), null);
		assert.equal(await deleteNote({ userId: userA, id: theirs.id, origin: "chat", visibleToBotId: bot1 }), false);
		assert.ok(await getNote(userA, theirs.id));
	});

	test("busca e fixadas respeitam o escopo do bot", async () => {
		await make({ botId: bot1, body: "xylophone do bot um", title: "Xilofone", pinned: true });
		await make({ botId: bot2, body: "xylophone do bot dois", title: "Xilofone dois", pinned: true });
		const found = await searchNotes({ userId: userA, botId: bot1, query: "xylophone" });
		assert.deepEqual(found.map((n) => n.botId), [bot1]);
		const pinned = await listPinnedNotes({ userId: userA, botId: bot1 });
		assert.ok(pinned.some((n) => n.title === "Xilofone") && !pinned.some((n) => n.title === "Xilofone dois"));
	});

	test("apagar registra o antes; desfazer recria; desfazer de novo é recusado", async () => {
		const note = await make({ title: "Lista", body: "pão e leite", pinned: true, botId: bot1 });
		assert.equal(await deleteNote({ userId: userA, id: note.id, origin: "chat" }), true);
		assert.equal(await getNote(userA, note.id), null);
		const removal = await lastChange(note.id);
		assert.deepEqual([removal.action, removal.before, removal.botId], ["remove", "pão e leite", bot1]);
		const undone = await undoMemoryChange({ userId: userA, changeId: removal.id });
		assert.ok(undone.ok, JSON.stringify(undone));
		const back = await getNote(userA, note.id);
		assert.deepEqual([back?.title, back?.body, back?.pinned, back?.botId], ["Lista", "pão e leite", true, bot1]);
		const again = await undoMemoryChange({ userId: userA, changeId: removal.id });
		assert.deepEqual([again.ok, !again.ok && again.code], [false, "already_undone"]);
	});

	test("desfazer edição devolve título, texto e fixada; se a nota mudou depois, recusa", async () => {
		const note = await make({ title: "T1", body: "corpo um" });
		await updateNote({ userId: userA, id: note.id, patch: { title: "T2", body: "corpo dois", pinned: true }, origin: "sleep" });
		const edit = await lastChange(note.id);
		const undone = await undoMemoryChange({ userId: userA, changeId: edit.id });
		assert.ok(undone.ok);
		const restored = await getNote(userA, note.id);
		assert.deepEqual([restored?.title, restored?.body, restored?.pinned], ["T1", "corpo um", false]);

		const note2 = await make({ body: "corpo A" });
		await updateNote({ userId: userA, id: note2.id, patch: { body: "corpo B" }, origin: "sleep" });
		const edit2 = await lastChange(note2.id);
		await updateNote({ userId: userA, id: note2.id, patch: { body: "corpo C" }, origin: "user" });
		const refused = await undoMemoryChange({ userId: userA, changeId: edit2.id });
		assert.deepEqual([refused.ok, !refused.ok && refused.code], [false, "stale"]);
		assert.equal((await getNote(userA, note2.id))?.body, "corpo C");
	});

	test("desfazer a criação apaga a nota (se intacta)", async () => {
		const note = await make({ body: "criada pelo sono", origin: "sleep" });
		const created = await lastChange(note.id);
		assert.ok((await undoMemoryChange({ userId: userA, changeId: created.id })).ok);
		assert.equal(await getNote(userA, note.id), null);
	});

	test("lista de mudanças do sono: só source sleep, filtrável por bot e por relatório", async () => {
		const note = await make({ botId: bot1, body: "feita numa noite", origin: "sleep", reportId: "rep-xyz" });
		await make({ botId: bot1, body: "feita pelo dono", origin: "user" });
		const page = await listSleepChanges({ userId: userA, botId: bot1, reportId: "rep-xyz" });
		assert.deepEqual(page.changes.map((c) => [c.entryId, c.source, c.reportId]), [[note.id, "sleep", "rep-xyz"]]);
		assert.deepEqual((await listSleepChanges({ userId: userB })).changes, []);
	});

	test("limite técnico por dono", async () => {
		const solo = (await createTestUser("note-cap")).id;
		await prisma.note.createMany({ data: Array.from({ length: OWNER_NOTES_MAX_PER_OWNER }, (_, i) => ({ userId: solo, title: `n${i}`, body: `corpo ${i}` })) });
		const over = await createNote({ userId: solo, botId: null, title: "mais uma", body: "não cabe", origin: "user" });
		assert.deepEqual([over.ok, !over.ok && over.code], [false, "limit"]);
	});
});
