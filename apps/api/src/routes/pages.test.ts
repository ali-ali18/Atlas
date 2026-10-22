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
