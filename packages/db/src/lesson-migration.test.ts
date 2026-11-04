import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { MemoryActionResult } from "@workspace/shared";
import { applyLessonMigration, buildLessonMigrationReport, parseLessonMigrationArgs, type LessonMigrationDeps } from "./lesson-migration.js";
import { FakeTable, installFakes } from "./testing/fake-tables.js";

let installed: { restore: () => void };
let lessons: FakeTable;
let facts: Map<string, string[]>;
let writes: Array<{ userId: string; botId: string; content: string }>;
let reads: string[];

const now = new Date("2026-11-04T12:00:00Z");
const recent = new Date("2026-10-20T12:00:00Z");

const lessonRow = (id: string, userId: string, botId: string, content: string, over: Record<string, unknown> = {}) => ({
	id, userId, botId, scope: "bot", scopeKey: null, content, origin: "correction", evidence: null, rule: null, helpful: 0, harmful: 0, uses: 1,
	status: "active", version: 1, supersedesId: null, createdAt: recent, updatedAt: recent, lastUsedAt: null, ...over,
});

const deps = (): LessonMigrationDeps => ({
	listOwners: async (filter) =>
		(lessons.rows as Array<{ userId: string; botId: string }>)
			.filter((row) => (!filter.userId || row.userId === filter.userId) && (!filter.botId || row.botId === filter.botId))
			.map((row) => ({ userId: row.userId, botId: row.botId }))
			.filter((ref, i, all) => all.findIndex((other) => other.userId === ref.userId && other.botId === ref.botId) === i),
	listLessons: async (userId, botId) => {
		reads.push(`${userId}/${botId}`);
		const { listBotLessons } = await import("./bot-lessons.js");
		return listBotLessons(userId, botId);
	},
	listFacts: async (userId, botId) => {
		const texts = facts.get(`${userId}/${botId}`) ?? [];
		return { texts, used: texts.reduce((n, t) => n + t.length, 0), limit: 2200 };
	},
	addFact: async ({ userId, botId, content }): Promise<MemoryActionResult> => {
		const key = `${userId}/${botId}`;
		const list = facts.get(key) ?? [];
		if (list.includes(content)) return { ok: false, error: "duplicado", currentEntries: [], usage: "" };
		facts.set(key, [...list, content]);
		writes.push({ userId, botId, content });
		return { ok: true };
	},
	now: () => now,
});

beforeEach(() => {
	facts = new Map();
	writes = [];
	reads = [];
	lessons = new FakeTable([
		lessonRow("la1", "user-a", "bot-a", "Ao enviar relatório, use PDF"),
		lessonRow("la2", "user-a", "bot-a", "ao enviar relatório, use PDF."),
		lessonRow("lb1", "user-b", "bot-b", "Segredo de negócio do dono B"),
	]);
	installed = installFakes({ bot: new FakeTable([{ id: "bot-a", ownerId: "user-a" }, { id: "bot-b", ownerId: "user-b" }]), botLesson: lessons });
});
afterEach(() => installed.restore());

test("relatório: um dono nunca vê a lição do outro e nada é gravado", async () => {
	const onlyA = await buildLessonMigrationReport({ userId: "user-a" }, deps());
	assert.equal(onlyA.owners.length, 1);
	assert.ok(onlyA.markdown.includes("Ao enviar relatório"));
	assert.ok(!onlyA.markdown.includes("Segredo de negócio do dono B"));
	assert.ok(!reads.some((read) => read.startsWith("user-b")));

	const all = await buildLessonMigrationReport({}, deps());
	assert.equal(all.owners.length, 2);
	const [sectionA, sectionB] = all.markdown.split("## Dono user-b");
	assert.ok(sectionA!.includes("Ao enviar relatório") && !sectionA!.includes("Segredo de negócio"));
	assert.ok(sectionB!.includes("Segredo de negócio") && !sectionB!.includes("Ao enviar relatório"));
	assert.equal(writes.length, 0);
	assert.equal(lessons.rows.length, 3);
});

test("relatório: bot de outro dono volta vazio mesmo se o par vier errado", async () => {
	const spoof: LessonMigrationDeps = { ...deps(), listOwners: async () => [{ userId: "user-b", botId: "bot-a" }] };
	const report = await buildLessonMigrationReport({}, spoof);
	assert.equal(report.owners.length, 0);
});

test("relatório marca a duplicada para juntar e o conflito para revisão", async () => {
	lessons.rows.push(lessonRow("la3", "user-a", "bot-a", "Envie sempre o resumo por e-mail"), lessonRow("la4", "user-a", "bot-a", "Nunca envie o resumo por e-mail"));
	const report = await buildLessonMigrationReport({ userId: "user-a" }, deps());
	const plan = report.owners[0]!.plan;
	assert.equal(plan.counts.merge, 1);
	assert.equal(plan.counts.needsReview, 2);
	assert.ok(report.markdown.includes("JUNTAR"));
});

test("--apply grava só o do dono pedido, uma vez, e é idempotente", async () => {
	const first = await applyLessonMigration({ userId: "user-a" }, deps());
	assert.deepEqual(writes.map((w) => [w.userId, w.botId, w.content]), [["user-a", "bot-a", writes[0]!.content]]);
	assert.equal(first.length, 1);
	assert.equal(first[0]!.written, 1);
	assert.equal(facts.has("user-b/bot-b"), false);
	assert.equal(lessons.rows.length, 3, "nenhuma lição é apagada nem aposentada");
	assert.ok(lessons.rows.every((row) => row.status === "active"));

	const second = await applyLessonMigration({ userId: "user-a" }, deps());
	assert.equal(writes.length, 1);
	assert.equal(second[0]!.written, 0);
});

test("--apply não grava o que pede revisão e exige o dono", async () => {
	lessons.rows.push(lessonRow("la3", "user-a", "bot-a", "Use sempre tabela no relatório mensal"), lessonRow("la4", "user-a", "bot-a", "Nunca use tabela no relatório mensal"));
	await applyLessonMigration({ userId: "user-a" }, deps());
	assert.deepEqual(writes.map((w) => w.content), ["Ao enviar relatório, use PDF"]);
	await assert.rejects(() => applyLessonMigration({ userId: " " }, deps()));
	assert.equal(writes.length, 1);
});

test("--apply: falha do addFact entra em failed sem derrubar o resto", async () => {
	const failing: LessonMigrationDeps = { ...deps(), addFact: async () => ({ ok: false, error: "limite excedido", currentEntries: [], usage: "" }) };
	const [result] = await applyLessonMigration({ userId: "user-a" }, failing);
	assert.equal(result!.written, 0);
	assert.equal(result!.failed.length, 1);
});

test("argumentos: --apply exige --user; relatório exige --out; flag desconhecida falha", () => {
	assert.deepEqual(parseLessonMigrationArgs(["--out", "r.md"]), { ok: true, mode: "report", out: "r.md" });
	assert.deepEqual(parseLessonMigrationArgs(["--out=r.md", "--user", "u1"]), { ok: true, mode: "report", out: "r.md", userId: "u1" });
	assert.deepEqual(parseLessonMigrationArgs(["--apply", "--user", "u1"]), { ok: true, mode: "apply", userId: "u1" });
	assert.equal(parseLessonMigrationArgs(["--apply"]).ok, false);
	assert.equal(parseLessonMigrationArgs([]).ok, false);
	assert.equal(parseLessonMigrationArgs(["--out", "r.md", "--force"]).ok, false);
	assert.equal(parseLessonMigrationArgs(["--out"]).ok, false);
	assert.equal(parseLessonMigrationArgs(["--apply", "--user", "u1", "--out", "x"]).ok, false);
});

test("args: --apply=false (valor inline) é rejeitado com erro claro, nunca aplica", () => {
	for (const arg of ["--apply=false", "--apply=0", "--apply="]) {
		const parsed = parseLessonMigrationArgs([arg, "--user", "u1"]);
		assert.equal(parsed.ok, false);
		if (!parsed.ok) assert.match(parsed.error, /--apply não aceita valor/);
	}
});

test("fato de conector usa o nome de exibição, nunca a chave interna", async () => {
	lessons = new FakeTable([
		lessonRow("lc1", "user-a", "bot-a", "Filtre por data", { scope: "connector", scopeKey: "mcp:cx1" }),
		lessonRow("lc2", "user-a", "bot-a", "Pagine os resultados", { scope: "connector", scopeKey: "mcp:cx2" }),
	]);
	installed.restore();
	installed = installFakes({ bot: new FakeTable([{ id: "bot-a", ownerId: "user-a" }]), botLesson: lessons });
	const report = await buildLessonMigrationReport({ userId: "user-a" }, { ...deps(), connectorNames: async () => new Map([["mcp:cx1", "Notion"]]) });
	assert.ok(report.markdown.includes("(conector Notion) Filtre por data"));
	// O relatório mostra o escopo da lição ao dono; o que não pode ter a chave interna é a linha do fato.
	const factLines = report.markdown.split("\n").filter((line) => line.includes("- fato:"));
	assert.equal(factLines.length, 2);
	assert.ok(factLines.every((line) => !line.includes("mcp:")));
	assert.ok(factLines.some((line) => line.includes("- fato: Pagine os resultados")));
});
