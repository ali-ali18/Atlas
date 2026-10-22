/** Páginas vivas: escopo por dono (IDOR), revisões (últimas 10), concorrência otimista e cartão atualizado no lugar. */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { parseConversationCard, parsePageSpec, type PageSpec } from "@workspace/shared";
import { prisma } from "./client.js";
import { FakeTable, installFakes } from "./testing/fake-tables.js";
import { persistConversationCardFromEvent } from "./conversations.js";
import { PAGE_REVISIONS_KEPT, createPage, deletePage, getPageForUser, listBotPagesForUser, listPageRevisionsForUser, updatePage } from "./pages.js";

let bots: FakeTable;
let pages: FakeTable;
let revisions: FakeTable;
let messages: FakeTable;
let installed: { restore: () => void };
let originalConversation: unknown;

beforeEach(() => {
	bots = new FakeTable([
		{ id: "bot-a", ownerId: "user-a" },
		{ id: "bot-b", ownerId: "user-b" },
	]);
	pages = new FakeTable([], () => ({ revision: 1, deletedAt: null, refreshedAt: null, createdAt: new Date(), updatedAt: new Date() }));
	revisions = new FakeTable([], () => ({ createdAt: new Date() }));
	messages = new FakeTable([], () => ({ createdAt: new Date() }));
	installed = installFakes({ bot: bots, page: pages, pageRevision: revisions, conversationMessage: messages });
	const client = prisma as unknown as Record<string, unknown>;
	originalConversation = client.conversation;
	client.conversation = { findUnique: async () => ({ id: "conv-1" }) };
});
afterEach(() => {
	installed.restore();
	(prisma as unknown as Record<string, unknown>).conversation = originalConversation;
});

function spec(title: string, text = "ola"): PageSpec {
	const parsed = parsePageSpec({ title, summary: "resumo", blocks: [{ type: "markdown", text }] });
	if (!parsed.ok) throw new Error(parsed.error);
	return parsed.spec;
}

test("createPage grava dono, revisão 1 e a revisão inicial; bot de outro dono é recusado", async () => {
	const page = await createPage("user-a", { botId: "bot-a", conversationId: "conv-1", spec: spec("Forecast"), sources: [{ title: "Fonte" }] });
	assert.ok(page);
	assert.equal(page.revision, 1);
	assert.equal(pages.rows[0]!.userId, "user-a");
	assert.equal(revisions.rows.length, 1);
	assert.equal(await createPage("user-a", { botId: "bot-b", spec: spec("x") }), null);
	assert.equal(await createPage("default", { botId: "bot-a", spec: spec("x") }), null);
	assert.equal(pages.rows.length, 1);
});

test("usuário B não lê, lista, atualiza nem apaga a página do usuário A", async () => {
	const page = (await createPage("user-a", { botId: "bot-a", spec: spec("Segredo") }))!;
	assert.equal(await getPageForUser(page.id, "user-b"), null);
	assert.deepEqual(await listBotPagesForUser("user-b", "bot-a"), []);
	assert.deepEqual(await updatePage(page.id, "user-b", { spec: spec("hack") }), { ok: false, error: "not_found" });
	assert.equal(await deletePage(page.id, "user-b"), false);
	assert.deepEqual(await listPageRevisionsForUser(page.id, "user-b"), []);
	assert.equal(pages.rows[0]!.title, "Segredo");
	assert.equal(pages.rows[0]!.deletedAt, null);
	assert.equal(pages.rows[0]!.revision, 1);
	// O dono continua vendo.
	assert.equal((await getPageForUser(page.id, "user-a"))?.title, "Segredo");
	assert.equal((await listBotPagesForUser("user-a", "bot-a")).length, 1);
});

test("legado \"default\" e usuário vazio nunca enxergam nada", async () => {
	const page = (await createPage("user-a", { botId: "bot-a", spec: spec("x") }))!;
	assert.equal(await getPageForUser(page.id, "default"), null);
	assert.equal(await getPageForUser(page.id, ""), null);
	assert.deepEqual(await listBotPagesForUser("default", "bot-a"), []);
});

test("updatePage sobe a revisão, guarda só as últimas 10 e mantém as fontes se não vierem", async () => {
	const page = (await createPage("user-a", { botId: "bot-a", spec: spec("v1"), sources: [{ title: "Fonte", url: "https://a.com/" }] }))!;
	for (let i = 2; i <= 13; i += 1) {
		const result = await updatePage(page.id, "user-a", { spec: spec(`v${i}`), expectedRevision: i - 1 });
		assert.ok(result.ok && result.page.revision === i);
	}
	const current = (await getPageForUser(page.id, "user-a"))!;
	assert.equal(current.title, "v13");
	assert.equal(current.revision, 13);
	assert.deepEqual(current.sources, [{ title: "Fonte", url: "https://a.com/" }]);
	assert.equal(revisions.rows.length, PAGE_REVISIONS_KEPT);
	assert.equal(Math.min(...revisions.rows.map((r) => r.revision as number)), 4);
	assert.equal((await listPageRevisionsForUser(page.id, "user-a"))[0]!.revision, 13);
});

test("revisão esperada velha dá conflict e não grava", async () => {
	const page = (await createPage("user-a", { botId: "bot-a", spec: spec("v1") }))!;
	assert.ok((await updatePage(page.id, "user-a", { spec: spec("v2"), expectedRevision: 1 })).ok);
	assert.deepEqual(await updatePage(page.id, "user-a", { spec: spec("v2-b"), expectedRevision: 1 }), { ok: false, error: "conflict" });
	assert.equal(pages.rows[0]!.title, "v2");
	assert.equal(pages.rows[0]!.revision, 2);
});

test("corrida: outra escrita entre a leitura e o updateMany vira conflict", async () => {
	const page = (await createPage("user-a", { botId: "bot-a", spec: spec("v1") }))!;
	pages.afterFindMany = undefined;
	const original = pages.updateMany.bind(pages);
	pages.updateMany = async (args) => {
		pages.rows[0]!.revision = 2; // alguém ganhou a corrida
		return original(args);
	};
	assert.deepEqual(await updatePage(page.id, "user-a", { spec: spec("perdeu") }), { ok: false, error: "conflict" });
	assert.equal(pages.rows[0]!.title, "v1");
});

test("deletePage some da leitura, da lista e do update", async () => {
	const page = (await createPage("user-a", { botId: "bot-a", spec: spec("x") }))!;
	assert.equal(await deletePage(page.id, "user-a"), true);
	assert.equal(await deletePage(page.id, "user-a"), false);
	assert.equal(await getPageForUser(page.id, "user-a"), null);
	assert.deepEqual(await listBotPagesForUser("user-a", "bot-a"), []);
	assert.deepEqual(await updatePage(page.id, "user-a", { spec: spec("y") }), { ok: false, error: "not_found" });
});

test("a lista traz resumo e contagem de fontes, mais recente primeiro", async () => {
	const first = (await createPage("user-a", { botId: "bot-a", spec: spec("Primeira"), sources: [{ title: "a" }, { title: "b" }] }))!;
	await createPage("user-a", { botId: "bot-a", spec: spec("Segunda") });
	pages.rows.find((r) => r.id === first.id)!.updatedAt = new Date(Date.now() + 10_000);
	const list = await listBotPagesForUser("user-a", "bot-a");
	assert.deepEqual(list.map((p) => p.title), ["Primeira", "Segunda"]);
	assert.equal(list[0]!.sourceCount, 2);
	assert.equal(list[0]!.summary, "resumo");
});

test("cartão de página: criar acrescenta, atualizar substitui o mesmo pageId no lugar", async () => {
	const event = (revision: number, action: string, title: string) => ({ type: "page", action, pageId: "page-1", revision, title, spec: spec(title), sourceCount: 2 });
	await persistConversationCardFromEvent("conv-1", event(1, "created", "Forecast"));
	await persistConversationCardFromEvent("conv-1", { ...event(1, "created", "Outra"), pageId: "page-2" });
	await persistConversationCardFromEvent("conv-1", event(2, "updated", "Forecast v2"));
	const rows = messages.rows as Array<{ role: string; content: string }>;
	assert.equal(rows.length, 2);
	assert.ok(rows.every((r) => r.role === "page"));
	const first = parseConversationCard(rows[0]!.content);
	assert.ok(first?.kind === "page");
	assert.equal(first.pageId, "page-1");
	assert.equal(first.revision, 2);
	assert.equal(first.action, "updated");
	assert.equal(first.title, "Forecast v2");
	assert.equal(first.sourceCount, 2);
});

test("cartão de página inválido (spec ruim) não é gravado", async () => {
	await persistConversationCardFromEvent("conv-1", { type: "page", action: "created", pageId: "p", revision: 1, title: "x", spec: { title: "x", blocks: [] }, sourceCount: 0 });
	assert.equal(messages.rows.length, 0);
});
