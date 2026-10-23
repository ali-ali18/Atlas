/**
 * GET /v1/bots/:botId/pages, GET e DELETE /v1/pages/:id: dono lê, lista e apaga; outro usuário recebe 404 (IDOR).
 * Prisma dublado em memória (mesma técnica de files.test.ts e scope.test.ts), com os `where` de verdade:
 * um filtro sem dono devolveria a página dos outros e o teste falharia.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";

const { Hono } = await import("hono");
const { prisma } = await import("@workspace/db");
const { parsePageSpec } = await import("@workspace/shared");
const { createPageRoutes } = await import("./pages.js");

const USER_A = "user-a-pages";
const USER_B = "user-b-pages";

type Row = {
	id: string;
	userId: string;
	botId: string;
	conversationId: string | null;
	title: string;
	specJson: unknown;
	sourcesJson: unknown;
	revision: number;
	refreshedAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
	deletedAt: Date | null;
	groupId?: string | null;
};

const spec = parsePageSpec({ title: "Forecast", summary: "Resumo", blocks: [{ type: "heading", text: "Oi" }] });
if (!spec.ok) throw new Error(spec.error);
const row = (id: string, userId: string, botId: string, over: Partial<Row> = {}): Row => ({
	id, userId, botId, conversationId: null, title: "Forecast", specJson: spec.spec, sourcesJson: [{ title: "CRM" }], revision: 3,
	refreshedAt: null, createdAt: new Date("2026-10-20T10:00:00Z"), updatedAt: new Date("2026-10-21T10:00:00Z"), deletedAt: null, ...over,
});
const pages: Row[] = [row("page-a", USER_A, "bot-a"), row("page-a2", USER_A, "bot-a", { updatedAt: new Date("2026-10-22T10:00:00Z") })];
const bots = [{ id: "bot-a", ownerId: USER_A }, { id: "bot-b", ownerId: USER_B }];

const match = (r: Row, where: Partial<Row>) => Object.entries(where).every(([key, value]) => (r as Record<string, unknown>)[key] === value);
const page = prisma.page as unknown as Record<string, unknown>;
const bot = prisma.bot as unknown as Record<string, unknown>;
page.findFirst = async ({ where }: { where: Partial<Row> }) => pages.find((r) => match(r, where)) ?? null;
page.findMany = async ({ where }: { where: Partial<Row> }) => pages.filter((r) => match(r, where)).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
page.updateMany = async ({ where, data }: { where: Partial<Row>; data: Partial<Row> }) => {
	const found = pages.filter((r) => match(r, where));
	for (const r of found) Object.assign(r, data);
	return { count: found.length };
};
bot.findFirst = async ({ where }: { where: { id: string; ownerId: string } }) => bots.find((b) => b.id === where.id && b.ownerId === where.ownerId) ?? null;

const groups = [
	{ id: "group-a", userId: USER_A, botId: "bot-a", name: "Vendas Loja Exemplo" },
	{ id: "group-b", userId: USER_B, botId: "bot-b", name: "Do B" },
];
const routines: Array<{ pageId: string; groupId: string | null; userId: string; botId: string }> = [];
const routineGroup = prisma.routineGroup as unknown as Record<string, unknown>;
routineGroup.findFirst = async ({ where }: { where: { id: string; botId: string; userId: string } }) =>
	groups.find((g) => g.id === where.id && g.botId === where.botId && g.userId === where.userId) ?? null;
routineGroup.findMany = async ({ where }: { where: { botId: string; userId: string } }) => groups.filter((g) => g.botId === where.botId && g.userId === where.userId);
(prisma.routine as unknown as Record<string, unknown>).findMany = async ({ where }: { where: { userId: string; botId: string; pageId: { in: string[] } } }) =>
	routines.filter((r) => r.userId === where.userId && r.botId === where.botId && where.pageId.in.includes(r.pageId) && r.groupId !== null);

const shareRows: Array<{ id: string; pageId: string; userId: string; tokenHash: string; createdAt: Date; revokedAt: Date | null }> = [];
const pageShare = prisma.pageShare as unknown as Record<string, unknown>;
const sameShare = (r: (typeof shareRows)[number], where: Record<string, unknown>) => Object.entries(where).every(([key, value]) => (r as Record<string, unknown>)[key] === value);
pageShare.findFirst = async ({ where }: { where: Record<string, unknown> }) => shareRows.find((r) => sameShare(r, where)) ?? null;
pageShare.create = async ({ data }: { data: Omit<(typeof shareRows)[number], "id" | "revokedAt"> }) => {
	const created = { id: `share-${shareRows.length + 1}`, revokedAt: null, ...data };
	shareRows.push(created);
	return created;
};
pageShare.updateMany = async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
	const found = shareRows.filter((r) => Object.entries(where).every(([key, value]) => (r as Record<string, unknown>)[key] === value));
	for (const r of found) Object.assign(r, data);
	return { count: found.length };
};

function appFor(userId: string) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		(c as unknown as { set: (k: string, v: unknown) => void }).set("session", { user: { id: userId } });
		await next();
	});
	app.route("/", createPageRoutes());
	return app;
}

test("dono lê a página com spec, fontes e revisão, sem cache compartilhado", async () => {
	const res = await appFor(USER_A).request("/v1/pages/page-a");
	assert.equal(res.status, 200);
	assert.equal(res.headers.get("cache-control"), "private, no-store");
	const body = (await res.json()) as { page: { id: string; revision: number; spec: { title: string }; sources: unknown[] } };
	assert.equal(body.page.id, "page-a");
	assert.equal(body.page.revision, 3);
	assert.equal(body.page.spec.title, "Forecast");
	assert.deepEqual(body.page.sources, [{ title: "CRM" }]);
});

test("usuário B recebe 404 ao ler a página de A (e inexistente dá o mesmo 404)", async () => {
	const foreign = await appFor(USER_B).request("/v1/pages/page-a");
	const missing = await appFor(USER_B).request("/v1/pages/page-nope");
	assert.equal(foreign.status, 404);
	assert.equal(missing.status, 404);
	assert.deepEqual(await foreign.json(), await missing.json());
});

test("lista do bot: dono vê as páginas, mais recente primeiro; bot de outro dono dá 404", async () => {
	const res = await appFor(USER_A).request("/v1/bots/bot-a/pages");
	assert.equal(res.status, 200);
	const body = (await res.json()) as { items: Array<{ id: string; summary?: string; sourceCount: number }> };
	assert.deepEqual(body.items.map((item) => item.id), ["page-a2", "page-a"]);
	assert.equal(body.items[0]!.summary, "Resumo");
	assert.equal(body.items[0]!.sourceCount, 1);
	assert.equal((await appFor(USER_B).request("/v1/bots/bot-a/pages")).status, 404);
	assert.equal((await appFor(USER_A).request("/v1/bots/bot-b/pages")).status, 404);
});

test("limit inválido dá 400", async () => {
	assert.equal((await appFor(USER_A).request("/v1/bots/bot-a/pages?limit=abc")).status, 400);
	assert.equal((await appFor(USER_A).request("/v1/bots/bot-a/pages?limit=0")).status, 400);
});

test("usuário B não apaga a página de A; o dono apaga e ela some da leitura e da lista", async () => {
	const blocked = await appFor(USER_B).request("/v1/pages/page-a2", { method: "DELETE" });
	assert.equal(blocked.status, 404);
	assert.equal(pages.find((r) => r.id === "page-a2")!.deletedAt, null);
	const ok = await appFor(USER_A).request("/v1/pages/page-a2", { method: "DELETE" });
	assert.equal(ok.status, 200);
	assert.deepEqual(await ok.json(), { ok: true });
	assert.equal((await appFor(USER_A).request("/v1/pages/page-a2")).status, 404);
	assert.equal((await appFor(USER_A).request("/v1/pages/page-a2", { method: "DELETE" })).status, 404);
	const list = (await (await appFor(USER_A).request("/v1/bots/bot-a/pages")).json()) as { items: Array<{ id: string }> };
	assert.deepEqual(list.items.map((item) => item.id), ["page-a"]);
});

test("lista traz o grupo efetivo (explícito ou da rotina ligada) com o nome", async () => {
	pages.push(row("page-a3", USER_A, "bot-a"));
	routines.push({ pageId: "page-a", groupId: "group-a", userId: USER_A, botId: "bot-a" });
	const list = (await (await appFor(USER_A).request("/v1/bots/bot-a/pages")).json()) as { items: Array<{ id: string; groupId: string | null; groupName: string | null; explicitGroupId: string | null }> };
	const byId = Object.fromEntries(list.items.map((item) => [item.id, item]));
	assert.deepEqual([byId["page-a"]!.groupId, byId["page-a"]!.groupName, byId["page-a"]!.explicitGroupId], ["group-a", "Vendas Loja Exemplo", null]);
	assert.equal(byId["page-a3"]!.groupId, null);
	routines.length = 0;
	pages.pop();
});

const patch = (userId: string, id: string, body: unknown) =>
	appFor(userId).request(`/v1/pages/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("PATCH move o painel para um grupo do dono e tira dele com null", async () => {
	const moved = await patch(USER_A, "page-a", { groupId: "group-a" });
	assert.equal(moved.status, 200);
	assert.deepEqual(await moved.json(), { ok: true, id: "page-a", groupId: "group-a" });
	assert.equal(pages.find((r) => r.id === "page-a")!.groupId, "group-a");
	assert.equal(pages.find((r) => r.id === "page-a")!.revision, 3);
	const cleared = await patch(USER_A, "page-a", { groupId: null });
	assert.deepEqual(await cleared.json(), { ok: true, id: "page-a", groupId: null });
});

test("PATCH: usuário B não move o painel de A, nem põe o próprio painel no grupo de A; tudo 404 idêntico", async () => {
	pages.push(row("page-b", USER_B, "bot-b"));
	const foreignPage = await patch(USER_B, "page-a", { groupId: "group-b" });
	const foreignGroup = await patch(USER_B, "page-b", { groupId: "group-a" });
	const missing = await patch(USER_B, "page-nope", { groupId: null });
	for (const res of [foreignPage, foreignGroup, missing]) assert.equal(res.status, 404);
	assert.deepEqual(await foreignPage.json(), await foreignGroup.json());
	assert.equal(pages.find((r) => r.id === "page-a")!.groupId ?? null, null);
	assert.equal(pages.find((r) => r.id === "page-b")!.groupId ?? null, null);
	pages.pop();
});

test("PATCH sem groupId ou com tipo errado dá 400", async () => {
	assert.equal((await patch(USER_A, "page-a", {})).status, 400);
	assert.equal((await patch(USER_A, "page-a", { groupId: 5 })).status, 400);
	assert.equal((await patch(USER_A, "page-a", { groupId: "  " })).status, 400);
	assert.equal((await appFor(USER_A).request("/v1/pages/page-a", { method: "PATCH", body: "oi" })).status, 400);
});

const call = (userId: string, id: string, method: string) => appFor(userId).request(`/v1/pages/${id}/share`, { method });

test("link público: o dono cria (URL só na resposta), consulta o estado e desativa", async () => {
	process.env.ATLAS_URL = "https://atlas.example.com";
	const created = await call(USER_A, "page-a", "POST");
	assert.equal(created.status, 200);
	const body = (await created.json()) as { active: boolean; url: string };
	assert.equal(body.active, true);
	assert.match(body.url, /^https:\/\/atlas\.example\.com\/p\/[A-Za-z0-9_-]{43}$/);
	assert.equal(created.headers.get("cache-control"), "private, no-store");
	const token = body.url.split("/p/")[1]!;
	assert.ok(!JSON.stringify(shareRows).includes(token), "o banco guarda só o hash");
	const status = (await (await call(USER_A, "page-a", "GET")).json()) as { active: boolean; createdAt: string | null; url?: string };
	assert.equal(status.active, true);
	assert.equal(status.url, undefined);
	const rotated = (await (await call(USER_A, "page-a", "POST")).json()) as { url: string };
	assert.notEqual(rotated.url, body.url);
	assert.equal(shareRows.length, 1);
	const revoked = await call(USER_A, "page-a", "DELETE");
	assert.equal(revoked.status, 200);
	assert.deepEqual(await revoked.json(), { active: false, createdAt: null });
	assert.equal(((await (await call(USER_A, "page-a", "GET")).json()) as { active: boolean }).active, false);
	assert.equal((await call(USER_A, "page-a", "DELETE")).status, 200);
});

test("link público: usuário B não cria, consulta nem revoga o link do painel de A (404 igual a inexistente)", async () => {
	await call(USER_A, "page-a", "POST");
	const before = JSON.stringify(shareRows);
	const attempts = await Promise.all(["POST", "GET", "DELETE"].map((method) => call(USER_B, "page-a", method)));
	const missing = await call(USER_B, "page-nope", "POST");
	for (const res of [...attempts, missing]) assert.equal(res.status, 404);
	assert.deepEqual(await attempts[0]!.json(), await missing.json());
	assert.equal(JSON.stringify(shareRows), before);
	await call(USER_A, "page-a", "DELETE");
});
