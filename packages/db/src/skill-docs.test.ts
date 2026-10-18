/**
 * Skills em Markdown no db: Prisma em memória (sem banco). Cobre caminho feliz,
 * limites, revisões e o isolamento entre donos (B não lê, altera nem apaga a
 * skill de A; o legado "default" não é dono válido).
 * Runner: `pnpm exec tsx --test src/skill-docs.test.ts` em packages/db.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { SKILL_MAX_PER_SCOPE, SKILL_REVISIONS_KEPT } from "@workspace/shared";
import {
	SkillDocError,
	countSkillDocs,
	createSkillDoc,
	deleteDraftSkillDocs,
	deleteSkillDoc,
	getSkillDoc,
	listSkillDocs,
	listSkillDocsForIndex,
	listSkillRevisions,
	readSkillDocByName,
	setSkillDocEnabled,
	skillContentHash,
	updateSkillDoc,
} from "./skill-docs.js";
import { FakeTable, installFakes } from "./testing/fake-tables.js";

const A = "user-a";
const B = "user-b";

let docs: FakeTable;
let revisions: FakeTable;
let bots: FakeTable;
let installed: { restore: () => void };

beforeEach(() => {
	const now = () => ({ createdAt: new Date(), updatedAt: new Date() });
	docs = new FakeTable([], () => ({ ...now(), revision: 1, enabled: true, status: "active", createdBy: "user", tools: [], botId: null, sourceKind: null, sourceSlug: null, sourceVersion: null, sourceHash: null }));
	revisions = new FakeTable([], () => ({ createdAt: new Date() }));
	bots = new FakeTable([
		{ id: "bot-1", ownerId: A },
		{ id: "bot-2", ownerId: A },
		{ id: "bot-b", ownerId: B },
	]);
	installed = installFakes({ skillDoc: docs, skillRevision: revisions, bot: bots });
});
afterEach(() => installed.restore());

const input = (name: string, extra: object = {}) => ({ name, description: `quando usar ${name}`, body: "1. passo", ...extra });
const rejectsKind = (promise: Promise<unknown>, kind: string) =>
	assert.rejects(promise, (error: unknown) => error instanceof SkillDocError && error.kind === kind);

test("cria, lista e lê a skill do dono", async () => {
	const created = await createSkillDoc(A, input("relatorio", { tools: ["github"] }));
	assert.equal(created.revision, 1);
	assert.deepEqual(created.tools, ["github"]);
	assert.equal((await getSkillDoc(A, created.id))?.name, "relatorio");
	assert.deepEqual((await listSkillDocs(A)).map((s) => s.name), ["relatorio"]);
});

test("B não lê, lista, altera, desliga nem apaga a skill de A", async () => {
	const skill = await createSkillDoc(A, input("privada"));
	assert.equal(await getSkillDoc(B, skill.id), null);
	assert.deepEqual(await listSkillDocs(B), []);
	assert.equal(await readSkillDocByName(B, "privada"), null);
	assert.deepEqual(await listSkillDocsForIndex(B), []);
	await rejectsKind(updateSkillDoc(B, skill.id, { body: "invadido" }), "not_found");
	assert.equal(await setSkillDocEnabled(B, skill.id, false), false);
	assert.equal(await deleteSkillDoc(B, skill.id), false);
	assert.deepEqual(await listSkillRevisions(B, skill.id), []);
	const still = await getSkillDoc(A, skill.id);
	assert.equal(still?.body, "1. passo");
	assert.equal(still?.enabled, true);
});

test("skill de bot exige bot do próprio dono", async () => {
	await rejectsKind(createSkillDoc(B, input("x", { botId: "bot-1" })), "not_found");
	await rejectsKind(createSkillDoc(A, input("x", { botId: "bot-b" })), "not_found");
	await rejectsKind(createSkillDoc(A, input("x", { botId: "inexistente" })), "not_found");
	assert.equal((await createSkillDoc(B, input("x", { botId: "bot-b" }))).botId, "bot-b");
	assert.equal(await countSkillDocs(A), 0);
});

test("legado default e dono vazio não leem nem gravam", async () => {
	for (const owner of ["default", "", "  "]) {
		await rejectsKind(createSkillDoc(owner, input("x")), "not_found");
		assert.deepEqual(await listSkillDocs(owner), []);
		assert.equal(await countSkillDocs(owner), 0);
	}
	docs.rows.push({ id: "legacy", userId: "default", botId: null, name: "velha", description: "d", body: "b", tools: [], enabled: true, status: "active", createdBy: "user", revision: 1, createdAt: new Date(), updatedAt: new Date() });
	assert.equal(await getSkillDoc("default", "legacy"), null);
	assert.equal(await getSkillDoc(A, "legacy"), null);
});

test("nome duplicado no mesmo escopo conflita; em escopos ou donos diferentes não", async () => {
	await createSkillDoc(A, input("dup"));
	await rejectsKind(createSkillDoc(A, input("dup")), "conflict");
	await createSkillDoc(A, input("dup", { botId: "bot-1" }));
	await rejectsKind(createSkillDoc(A, input("dup", { botId: "bot-1" })), "conflict");
	await createSkillDoc(B, input("dup"));
});

test("valida campos e devolve erro pt-BR", async () => {
	await assert.rejects(createSkillDoc(A, input("Nome Ruim")), (error: unknown) => error instanceof SkillDocError && error.kind === "invalid" && /slug/.test(error.message));
	await rejectsKind(createSkillDoc(A, { ...input("ok"), description: "x".repeat(301) }), "invalid");
	await rejectsKind(createSkillDoc(A, { ...input("ok"), body: "" }), "invalid");
	assert.equal(await countSkillDocs(A), 0);
});

test("limite de skills por escopo", async () => {
	for (let i = 0; i < SKILL_MAX_PER_SCOPE; i++) await createSkillDoc(A, input(`s-${i}`));
	await rejectsKind(createSkillDoc(A, input("estouro")), "limit");
	await createSkillDoc(A, input("de-bot", { botId: "bot-1" }));
	await createSkillDoc(B, input("do-outro"));
});

test("segredo é redigido ao salvar (descrição e corpo)", async () => {
	const token = `ghp_${"a".repeat(30)}`;
	const created = await createSkillDoc(A, { name: "segredo", description: `use ${token}`, body: `curl -H "Authorization: Bearer ${"x".repeat(24)}" ${token}` });
	assert.ok(!created.description.includes(token));
	assert.ok(!created.body.includes(token));
	assert.ok(created.body.includes("[redacted]"));
	const edited = await updateSkillDoc(A, created.id, { body: `novo ${token}` });
	assert.ok(!edited.body.includes(token));
});

test("update guarda a revisão anterior, incrementa e poda as últimas N", async () => {
	const skill = await createSkillDoc(A, input("evolui"));
	for (let i = 2; i <= SKILL_REVISIONS_KEPT + 4; i++) {
		const next = await updateSkillDoc(A, skill.id, { body: `versao ${i}` });
		assert.equal(next.revision, i);
	}
	const kept = await listSkillRevisions(A, skill.id);
	assert.equal(kept.length, SKILL_REVISIONS_KEPT);
	assert.equal(kept[0]?.revision, SKILL_REVISIONS_KEPT + 3);
	assert.equal(kept[0]?.body, `versao ${SKILL_REVISIONS_KEPT + 3}`);
	assert.equal(revisions.rows.length, SKILL_REVISIONS_KEPT);
});

test("update com revisão desatualizada falha e não grava", async () => {
	const skill = await createSkillDoc(A, input("concorrente"));
	await updateSkillDoc(A, skill.id, { body: "edição 1", expectedRevision: 1 });
	await rejectsKind(updateSkillDoc(A, skill.id, { body: "edição 2", expectedRevision: 1 }), "stale");
	assert.equal((await getSkillDoc(A, skill.id))?.body, "edição 1");
});

test("renomear para nome já usado conflita", async () => {
	const first = await createSkillDoc(A, input("um"));
	await createSkillDoc(A, input("dois"));
	await rejectsKind(updateSkillDoc(A, first.id, { name: "dois" }), "conflict");
});

test("índice: conta + bot, só ativas e habilitadas, bot vence a colisão", async () => {
	await createSkillDoc(A, input("comum"));
	await createSkillDoc(A, { ...input("comum", { botId: "bot-1" }), description: "versão do bot" });
	await createSkillDoc(A, input("so-conta"));
	await createSkillDoc(A, input("desligada"));
	await createSkillDoc(A, input("rascunho", { status: "draft" }));
	await createSkillDoc(A, input("de-outro-bot", { botId: "bot-2" }));
	const off = (await listSkillDocs(A)).find((s) => s.name === "desligada")!;
	await setSkillDocEnabled(A, off.id, false);

	const index = await listSkillDocsForIndex(A, "bot-1");
	assert.deepEqual(index.map((e) => e.name).sort(), ["comum", "so-conta"]);
	assert.equal(index.find((e) => e.name === "comum")?.description, "versão do bot");
	assert.deepEqual((await listSkillDocsForIndex(A)).map((e) => e.name).sort(), ["comum", "so-conta"]);
});

test("readSkillDocByName: bot antes da conta; rascunho e desligada não leem", async () => {
	await createSkillDoc(A, { ...input("x"), body: "da conta" });
	await createSkillDoc(A, { ...input("x", { botId: "bot-1" }), body: "do bot" });
	await createSkillDoc(A, input("rasc", { status: "draft" }));
	assert.equal((await readSkillDocByName(A, "x", "bot-1"))?.body, "do bot");
	assert.equal((await readSkillDocByName(A, "x", "bot-9"))?.body, "da conta");
	assert.equal(await readSkillDocByName(A, "rasc"), null);
	assert.equal(await readSkillDocByName(A, "inexistente"), null);
});

test("rascunho nasce desligado; apagar remove só do dono", async () => {
	const draft = await createSkillDoc(A, input("rasc", { status: "draft" }));
	assert.equal(draft.enabled, false);
	assert.equal(draft.status, "draft");
	assert.equal(await deleteSkillDoc(A, draft.id), true);
	assert.equal(await getSkillDoc(A, draft.id), null);
	assert.equal(await deleteSkillDoc(A, draft.id), false);
});

test("apagar rascunhos em lote: só rascunhos do dono, por escopo, e devolve a contagem", async () => {
	await createSkillDoc(A, input("ativa"));
	await createSkillDoc(A, input("rasc-conta", { status: "draft" }));
	await createSkillDoc(A, input("rasc-bot", { status: "draft", botId: "bot-1" }));
	const other = await createSkillDoc(B, input("rasc-de-b", { status: "draft" }));
	assert.equal(await deleteDraftSkillDocs(A, { botId: null }), 1);
	assert.deepEqual((await listSkillDocs(A)).map((s) => s.name), ["ativa", "rasc-bot"]);
	assert.equal(await deleteDraftSkillDocs(A), 1);
	assert.deepEqual((await listSkillDocs(A)).map((s) => s.name), ["ativa"]);
	assert.equal(await deleteDraftSkillDocs(A), 0);
	assert.equal((await getSkillDoc(B, other.id))?.name, "rasc-de-b", "rascunho de B intacto");
	assert.equal(await deleteDraftSkillDocs("default"), 0, "dono legado não é válido");
});

test("origem do catálogo: grava hash, detecta edição e a atualização regrava a origem", async () => {
	const created = await createSkillDoc(A, input("roblox", { source: { kind: "catalog", slug: "roblox", version: "1.0.0" } }));
	assert.deepEqual(created.source, { kind: "catalog", slug: "roblox", version: "1.0.0", edited: false });
	assert.equal(docs.rows[0]?.sourceHash, skillContentHash({ description: created.description, tools: created.tools, body: created.body }));

	const edited = await updateSkillDoc(A, created.id, { body: "1. passo\n2. meu passo" });
	assert.equal(edited.source?.edited, true);
	assert.equal(edited.source?.version, "1.0.0");

	const refreshed = await updateSkillDoc(A, created.id, { body: "1. passo novo", source: { kind: "catalog", slug: "roblox", version: "1.1.0" } });
	assert.deepEqual(refreshed.source, { kind: "catalog", slug: "roblox", version: "1.1.0", edited: false });

	const plain = await createSkillDoc(A, input("minha"));
	assert.equal(plain.source, null);
	const cleared = await updateSkillDoc(A, created.id, { source: null });
	assert.equal(cleared.source, null);
});
