/** Link público do painel: só o hash do token no banco, dono-escopo, revogação e leitura pública mínima. */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { parsePageSpec } from "@workspace/shared";
import { FakeTable, installFakes } from "./testing/fake-tables.js";
import { createOrRotatePageShare, getPageShareStatus, getSharedPageByToken, revokePageShare } from "./page-shares.js";

process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";

let pages: FakeTable;
let shares: FakeTable;
let bots: FakeTable;
let installed: { restore: () => void };

beforeEach(() => {
	const parsed = parsePageSpec({ v: 2, title: "Vendas", summary: "Resumo", root: { type: "stack", children: [{ type: "divider" }] } });
	if (!parsed.ok) throw new Error(parsed.error);
	pages = new FakeTable([
		{
			id: "page-a",
			userId: "user-a",
			botId: "bot-a",
			title: "Vendas",
			specJson: parsed.spec,
			sourcesJson: [{ title: "CRM interno", url: "https://crm.interno/x" }],
			deletedAt: null,
			refreshedAt: null,
			createdAt: new Date(),
			updatedAt: new Date("2026-10-20T10:00:00Z"),
			conversationId: "conv-secreta",
		},
	]);
	shares = new FakeTable([], () => ({ createdAt: new Date(), revokedAt: null }));
	bots = new FakeTable([{ id: "bot-a", ownerId: "user-a", name: "Atlas Vendas" }]);
	installed = installFakes({ page: pages, pageShare: shares, bot: bots });
});
afterEach(() => installed.restore());

test("o token tem 256 bits, o banco guarda só o hash e a leitura pública devolve o mínimo", async () => {
	const created = (await createOrRotatePageShare("page-a", "user-a"))!;
	assert.match(created.token, /^[A-Za-z0-9_-]{43}$/);
	assert.equal(shares.rows.length, 1);
	assert.notEqual(shares.rows[0]!.tokenHash, created.token);
	assert.ok(!JSON.stringify(shares.rows).includes(created.token));
	const view = (await getSharedPageByToken(created.token))!;
	assert.equal(view.title, "Vendas");
	assert.equal(view.summary, "Resumo");
	assert.equal(view.botName, "Atlas Vendas");
	assert.deepEqual(Object.keys(view).sort(), ["botName", "spec", "summary", "title", "updatedAt"]);
	const json = JSON.stringify(view);
	assert.ok(!json.includes("user-a") && !json.includes("conv-secreta") && !json.includes("crm.interno") && !json.includes("bot-a"));
});

test("girar o token invalida o link antigo; revogar derruba o link; recriar reativa", async () => {
	const first = (await createOrRotatePageShare("page-a", "user-a"))!;
	const second = (await createOrRotatePageShare("page-a", "user-a"))!;
	assert.notEqual(first.token, second.token);
	assert.equal(shares.rows.length, 1);
	assert.equal(await getSharedPageByToken(first.token), null);
	assert.ok(await getSharedPageByToken(second.token));
	assert.equal(await revokePageShare("page-a", "user-a"), true);
	assert.equal(await getSharedPageByToken(second.token), null);
	assert.deepEqual(await getPageShareStatus("page-a", "user-a"), { active: false, createdAt: null });
	assert.equal(await revokePageShare("page-a", "user-a"), false);
	const third = (await createOrRotatePageShare("page-a", "user-a"))!;
	assert.ok(await getSharedPageByToken(third.token));
	assert.equal((await getPageShareStatus("page-a", "user-a"))?.active, true);
});

test("token desconhecido, malformado ou de painel apagado dá null", async () => {
	const { token } = (await createOrRotatePageShare("page-a", "user-a"))!;
	assert.equal(await getSharedPageByToken("x".repeat(43)), null);
	assert.equal(await getSharedPageByToken("curto"), null);
	assert.equal(await getSharedPageByToken(""), null);
	assert.equal(await getSharedPageByToken(`${token}extra`), null);
	pages.rows[0]!.deletedAt = new Date();
	assert.equal(await getSharedPageByToken(token), null);
});

test("usuário B não cria, gira, revoga nem consulta o link do painel de A; default também não", async () => {
	const { token } = (await createOrRotatePageShare("page-a", "user-a"))!;
	assert.equal(await createOrRotatePageShare("page-a", "user-b"), null);
	assert.equal(await revokePageShare("page-a", "user-b"), null);
	assert.equal(await getPageShareStatus("page-a", "user-b"), null);
	assert.equal(await createOrRotatePageShare("page-a", "default"), null);
	assert.equal(shares.rows.length, 1);
	assert.equal(shares.rows[0]!.revokedAt ?? null, null);
	assert.ok(await getSharedPageByToken(token));
});
