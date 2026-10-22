import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { LESSON_MAX_ACTIVE, type LessonDelta } from "@workspace/shared";
import { applyLessonDeltas, getBotLesson, listBotLessons, listLessonsForPrompt, recordLessonFeedback, restoreBotLessonVersion, retireBotLesson, updateBotLessonContent } from "./bot-lessons.js";
import { FakeTable, installFakes } from "./testing/fake-tables.js";

let bots: FakeTable;
let lessons: FakeTable;
let installed: { restore: () => void };
const noEmbed = { embed: async () => null, duplicatePairs: async () => [] };

beforeEach(() => {
	delete process.env.OPENROUTER_API_KEY;
	bots = new FakeTable([
		{ id: "bot-a", ownerId: "user-a" },
		{ id: "bot-b", ownerId: "user-b" },
	]);
	lessons = new FakeTable([], () => ({ status: "active", helpful: 0, harmful: 0, uses: 0, version: 1, supersedesId: null, evidence: null, rule: null, lastUsedAt: null, createdAt: new Date(), updatedAt: new Date() }));
	installed = installFakes({ bot: bots, botLesson: lessons });
});
afterEach(() => installed.restore());

const add = (content: string, over: Partial<Extract<LessonDelta, { op: "add" }>> = {}): LessonDelta => ({ op: "add", scope: "bot", content, origin: "correction", ...over });

test("add grava a lição com dono e bot, e recusa bot de outro usuário", async () => {
	const ok = await applyLessonDeltas("bot-a", [add("Ao responder, seja breve — porque o usuário prefere")], { userId: "user-a" }, noEmbed);
	assert.ok(ok.ok && ok.added === 1);
	assert.equal(lessons.rows[0]!.userId, "user-a");
	const foreign = await applyLessonDeltas("bot-a", [add("Ao responder, seja longo — porque sim")], { userId: "user-b" }, noEmbed);
	assert.deepEqual(foreign, { ok: false, error: "not_found" });
	assert.equal(lessons.rows.length, 1);
});

test("usuário B não lê, edita, apaga, restaura nem dá feedback na lição do usuário A", async () => {
	await applyLessonDeltas("bot-a", [add("Ao enviar, confirme o destinatário — porque já errou")], { userId: "user-a" }, noEmbed);
	const id = lessons.rows[0]!.id as string;
	assert.deepEqual(await listBotLessons("user-b", "bot-a"), []);
	assert.equal(await getBotLesson("user-b", id), null);
	assert.equal(await updateBotLessonContent("user-b", id, "hack"), null);
	assert.equal(await retireBotLesson("user-b", id), null);
	assert.equal(await restoreBotLessonVersion("user-b", id), null);
	assert.deepEqual(await listLessonsForPrompt("user-b", "bot-a"), []);
	const fb = await recordLessonFeedback("user-b", "bot-a", [{ ref: id, outcome: "hurt" }]);
	assert.deepEqual(fb.applied, []);
	assert.equal(lessons.rows[0]!.status, "active");
	assert.equal(lessons.rows[0]!.harmful, 0);
});

test("editar cria versão nova e restaurar volta a anterior (histórico preservado)", async () => {
	await applyLessonDeltas("bot-a", [add("Ao listar, use o filtro — porque pagina")], { userId: "user-a" }, noEmbed);
	const first = lessons.rows[0]!.id as string;
	const edited = await updateBotLessonContent("user-a", first, "Ao listar, use o filtro de data — porque pagina");
	assert.ok(edited && edited.canRestore && edited.version === 2 && edited.supersedesId === first);
	assert.equal(lessons.rows.length, 2);
	assert.equal(lessons.rows.find((row) => row.id === first)!.status, "retired");
	assert.deepEqual((await listBotLessons("user-a", "bot-a")).map((item) => item.content), ["Ao listar, use o filtro de data — porque pagina"]);
	const restored = await restoreBotLessonVersion("user-a", edited.id);
	assert.equal(restored?.id, first);
	assert.equal(restored?.status, "active");
	assert.deepEqual((await listBotLessons("user-a", "bot-a")).map((item) => item.id), [first]);
	assert.equal(await restoreBotLessonVersion("user-a", first), null, "sem versão anterior");
});

test("apagar aposenta (não remove a linha)", async () => {
	await applyLessonDeltas("bot-a", [add("Ao X, faça Y — porque Z")], { userId: "user-a" }, noEmbed);
	const id = lessons.rows[0]!.id as string;
	assert.equal((await retireBotLesson("user-a", id))?.status, "retired");
	assert.equal(lessons.rows.length, 1);
	assert.deepEqual(await listBotLessons("user-a", "bot-a"), []);
});

test("passar de 60 ativas aposenta as piores (e primeiro as duplicatas semânticas)", async () => {
	const seed = Array.from({ length: LESSON_MAX_ACTIVE }, (_, n) => add(`Ao caso ${n}, faça ${n} — porque ${n}`));
	await applyLessonDeltas("bot-a", seed, { userId: "user-a" }, noEmbed);
	assert.equal(lessons.rows.filter((row) => row.status === "active").length, LESSON_MAX_ACTIVE);
	// a de índice 0 ajuda; a de índice 1 atrapalha e é a que sai
	lessons.rows[0]!.helpful = 4;
	lessons.rows[1]!.harmful = 2;
	const result = await applyLessonDeltas("bot-a", [add("Ao caso novo, faça novo — porque novo")], { userId: "user-a" }, noEmbed);
	assert.ok(result.ok && result.evicted === 1);
	assert.equal(lessons.rows.filter((row) => row.status === "active").length, LESSON_MAX_ACTIVE);
	assert.equal(lessons.rows[1]!.status, "retired");
	assert.equal(lessons.rows[0]!.status, "active");

	// duplicata semântica sai antes da de menor saldo
	const dupA = lessons.rows[10]!.id as string;
	const dupB = lessons.rows[11]!.id as string;
	lessons.rows[10]!.helpful = 1;
	const again = await applyLessonDeltas("bot-a", [add("Ao outro caso, faça outro — porque outro")], { userId: "user-a" }, { ...noEmbed, duplicatePairs: async () => [{ a: dupA, b: dupB, distance: 0.02 }] });
	assert.ok(again.ok && again.evicted === 1);
	assert.equal(lessons.rows.find((row) => row.id === dupB)!.status, "retired");
	assert.equal(lessons.rows.find((row) => row.id === dupA)!.status, "active");
});

test("feedback: uses sobe, helpful/harmful conforme o resultado, e aposenta com saldo -3", async () => {
	await applyLessonDeltas("bot-a", [add("Ao X, faça Y — porque Z"), add("Ao W, faça V — porque U")], { userId: "user-a" }, noEmbed);
	const [a, b] = lessons.rows.map((row) => row.id as string) as [string, string];
	const refA = `L${a.slice(-4)}`;
	const out = await recordLessonFeedback("user-a", "bot-a", [{ ref: refA, outcome: "helped" }, { ref: b, outcome: "applied" }, { ref: "Lzzzz", outcome: "hurt" }]);
	assert.deepEqual(out.applied, [a, b]);
	assert.deepEqual(out.unknown, ["Lzzzz"]);
	assert.equal(lessons.rows[0]!.uses, 1);
	assert.equal(lessons.rows[0]!.helpful, 1);
	assert.equal(lessons.rows[1]!.helpful, 0);
	assert.ok(lessons.rows[0]!.lastUsedAt instanceof Date);
	lessons.rows[1]!.harmful = 2;
	const bad = await recordLessonFeedback("user-a", "bot-a", [{ ref: b, outcome: "hurt" }]);
	assert.deepEqual(bad.retired, [b]);
	assert.equal(lessons.rows[1]!.status, "retired");
});

test("injeção: só as do bot e as dos escopos carregados, e nunca as aposentadas", async () => {
	await applyLessonDeltas("bot-a", [
		add("Ao X, faça Y — porque Z"),
		add("Ao listar, passe o id interno — porque falha", { scope: "connector", scopeKey: "mcp:c1" }),
		add("Ao listar outro, passe o id — porque falha", { scope: "connector", scopeKey: "mcp:c2" }),
	], { userId: "user-a" }, noEmbed);
	assert.equal((await listLessonsForPrompt("user-a", "bot-a")).length, 1);
	assert.equal((await listLessonsForPrompt("user-a", "bot-a", { scopeKeys: ["mcp:c1"] })).length, 2);
	await retireBotLesson("user-a", lessons.rows[1]!.id as string);
	assert.equal((await listLessonsForPrompt("user-a", "bot-a", { scopeKeys: ["mcp:c1"] })).length, 1);
	assert.deepEqual(await listLessonsForPrompt("user-a", "bot-b", { scopeKeys: ["mcp:c1"] }), []);
});
