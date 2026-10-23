/** Páginas vivas: escopo por dono (IDOR), revisões (últimas 10), concorrência otimista e cartão atualizado no lugar. */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { parseConversationCard, parsePageSpec, type PageSpec } from "@workspace/shared";
import { prisma } from "./client.js";
import { FakeTable, installFakes } from "./testing/fake-tables.js";
import { persistConversationCardFromEvent } from "./conversations.js";
import { PAGE_REVISIONS_KEPT, createPage, deletePage, getPageForUser, listBotPagesForUser, listPageRevisionsForUser, resolvePageGroup, setPageGroup, updatePage } from "./pages.js";

let bots: FakeTable;
let pages: FakeTable;
let revisions: FakeTable;
let messages: FakeTable;
let groups: FakeTable;
let routines: FakeTable;
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
	groups = new FakeTable(
		[
			{ id: "g-a", userId: "user-a", botId: "bot-a", name: "Vendas Loja Exemplo", description: "", createdAt: new Date(), updatedAt: new Date() },
			{ id: "g-a2", userId: "user-a", botId: "bot-a", name: "Financeiro", description: "", createdAt: new Date(), updatedAt: new Date() },
			{ id: "g-b", userId: "user-b", botId: "bot-b", name: "Do B", description: "", createdAt: new Date(), updatedAt: new Date() },
		],
		() => ({ description: "", createdAt: new Date(), updatedAt: new Date() }),
	);
	routines = new FakeTable([]);
	installed = installFakes({ bot: bots, page: pages, pageRevision: revisions, conversationMessage: messages, routineGroup: groups, routine: routines });
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
	assert.equal(await listBotPagesForUser("user-b", "bot-a"), null);
	assert.deepEqual(await updatePage(page.id, "user-b", { spec: spec("hack") }), { ok: false, error: "not_found" });
	assert.equal(await deletePage(page.id, "user-b"), false);
	assert.deepEqual(await listPageRevisionsForUser(page.id, "user-b"), []);
	assert.equal(pages.rows[0]!.title, "Segredo");
	assert.equal(pages.rows[0]!.deletedAt, null);
	assert.equal(pages.rows[0]!.revision, 1);
	// O dono continua vendo.
	assert.equal((await getPageForUser(page.id, "user-a"))?.title, "Segredo");
	assert.equal((await listBotPagesForUser("user-a", "bot-a"))?.length, 1);
});

test("legado \"default\" e usuário vazio nunca enxergam nada", async () => {
	const page = (await createPage("user-a", { botId: "bot-a", spec: spec("x") }))!;
	assert.equal(await getPageForUser(page.id, "default"), null);
	assert.equal(await getPageForUser(page.id, ""), null);
	assert.equal(await listBotPagesForUser("default", "bot-a"), null);
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
	const list = (await listBotPagesForUser("user-a", "bot-a"))!;
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

test("painel nasce num grupo do próprio dono e bot; grupo de outro dono ou de outro bot é recusado", async () => {
	const page = await createPage("user-a", { botId: "bot-a", groupId: "g-a", spec: spec("Vendas") });
	assert.equal(page?.groupId, "g-a");
	await assert.rejects(createPage("user-a", { botId: "bot-a", groupId: "g-b", spec: spec("x") }), /Grupo não encontrado/);
	assert.equal(pages.rows.length, 1);
});

test("setPageGroup move e desfaz o grupo sem mexer em revisão nem updatedAt", async () => {
	const page = (await createPage("user-a", { botId: "bot-a", spec: spec("Vendas") }))!;
	const before = pages.rows[0]!.updatedAt;
	const moved = await setPageGroup(page.id, "user-a", "g-a");
	assert.ok(moved.ok && moved.page.groupId === "g-a");
	assert.equal(pages.rows[0]!.revision, 1);
	assert.equal(pages.rows[0]!.updatedAt, before);
	const cleared = await setPageGroup(page.id, "user-a", null);
	assert.ok(cleared.ok && cleared.page.groupId === null);
});

test("usuário B não move painel do A nem põe o próprio painel em grupo do A", async () => {
	const a = (await createPage("user-a", { botId: "bot-a", spec: spec("Do A") }))!;
	const b = (await createPage("user-b", { botId: "bot-b", spec: spec("Do B") }))!;
	assert.deepEqual(await setPageGroup(a.id, "user-b", "g-b"), { ok: false, error: "not_found" });
	assert.deepEqual(await setPageGroup(a.id, "user-b", null), { ok: false, error: "not_found" });
	assert.deepEqual(await setPageGroup(b.id, "user-b", "g-a"), { ok: false, error: "group_not_found" });
	assert.deepEqual(await setPageGroup(a.id, "default", "g-a"), { ok: false, error: "not_found" });
	assert.equal(pages.rows.find((r) => r.id === a.id)!.groupId ?? null, null);
	assert.equal(pages.rows.find((r) => r.id === b.id)!.groupId ?? null, null);
});

test("grupo de outro bot do mesmo dono também é recusado", async () => {
	bots.rows.push({ id: "bot-a2", ownerId: "user-a" });
	groups.rows.push({ id: "g-outro-bot", userId: "user-a", botId: "bot-a2", name: "Outro", description: "" });
	const page = (await createPage("user-a", { botId: "bot-a", spec: spec("x") }))!;
	assert.deepEqual(await setPageGroup(page.id, "user-a", "g-outro-bot"), { ok: false, error: "group_not_found" });
});

test("a lista traz o grupo efetivo: o explícito ou o da rotina ligada ao painel", async () => {
	const solto = (await createPage("user-a", { botId: "bot-a", spec: spec("Solto") }))!;
	const explicito = (await createPage("user-a", { botId: "bot-a", groupId: "g-a2", spec: spec("Explícito") }))!;
	const viaRotina = (await createPage("user-a", { botId: "bot-a", spec: spec("Via rotina") }))!;
	routines.rows.push(
		{ id: "r1", userId: "user-a", botId: "bot-a", pageId: viaRotina.id, groupId: "g-a" },
		{ id: "r2", userId: "user-a", botId: "bot-a", pageId: explicito.id, groupId: "g-a" },
		{ id: "r3", userId: "user-a", botId: "bot-a", pageId: solto.id, groupId: null },
		{ id: "r4", userId: "user-b", botId: "bot-b", pageId: solto.id, groupId: "g-b" },
	);
	const list = (await listBotPagesForUser("user-a", "bot-a"))!;
	const byTitle = Object.fromEntries(list.map((item) => [item.title, [item.groupId, item.explicitGroupId]]));
	assert.deepEqual(byTitle, { Solto: [null, null], Explícito: ["g-a2", "g-a2"], "Via rotina": ["g-a", null] });
});

test("resolvePageGroup: por id, por nome (sem caixa), nome novo cria; id de outro dono é recusado", async () => {
	assert.deepEqual(await resolvePageGroup("user-a", "bot-a", "g-a"), { id: "g-a", name: "Vendas Loja Exemplo", created: false });
	assert.equal((await resolvePageGroup("user-a", "bot-a", "  vendas   loja-exemplo ")).id, "g-a");
	const fresh = await resolvePageGroup("user-a", "bot-a", "Logística");
	assert.equal(fresh.created, true);
	assert.equal(groups.rows.find((r) => r.id === fresh.id)!.userId, "user-a");
	const foreignId = "cmoutrodono0000000000001";
	groups.rows.push({ id: foreignId, userId: "user-b", botId: "bot-b", name: "Segredo", description: "" });
	const before = groups.rows.length;
	await assert.rejects(resolvePageGroup("user-a", "bot-a", foreignId), /Grupo não encontrado/);
	assert.equal(groups.rows.length, before);
	await assert.rejects(resolvePageGroup("default", "bot-a", "Vendas"), /Grupo não encontrado/);
});
