/**
 * GET /v1/public/paineis/:token: leitura pública do painel compartilhado. Usa o db de verdade sobre Prisma dublado
 * (hash do token, revogação, painel apagado) e confere que a resposta não traz dono, conversa nem fontes.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";
process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";

const { Hono } = await import("hono");
const { prisma, createOrRotatePageShare, revokePageShare } = await import("@workspace/db");
const { parsePageSpec } = await import("@workspace/shared");
const { createPublicPageRoutes } = await import("./public-pages.js");

const spec = parsePageSpec({ v: 2, title: "Vendas", summary: "Resumo", root: { type: "stack", children: [{ type: "divider" }] } });
if (!spec.ok) throw new Error(spec.error);

const pages = [
	{ id: "page-a", userId: "user-a", botId: "bot-a", title: "Vendas", specJson: spec.spec, sourcesJson: [{ title: "CRM", url: "https://crm.interno/x" }], conversationId: "conv-secreta", deletedAt: null as Date | null, refreshedAt: null, updatedAt: new Date("2026-10-20T10:00:00Z") },
];
const shares: Array<Record<string, unknown>> = [];
const matchRow = (row: Record<string, unknown>, where: Record<string, unknown>) => Object.entries(where).every(([key, value]) => row[key] === value);
const model = (rows: Array<Record<string, unknown>>) => ({
	findFirst: async ({ where }: { where: Record<string, unknown> }) => rows.find((row) => matchRow(row, where)) ?? null,
	updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
		const found = rows.filter((row) => matchRow(row, where));
		for (const row of found) Object.assign(row, data);
		return { count: found.length };
	},
	create: async ({ data }: { data: Record<string, unknown> }) => {
		const row = { id: `share-${rows.length + 1}`, revokedAt: null, ...data };
		rows.push(row);
		return row;
	},
});
Object.assign(prisma.page, model(pages as never));
Object.assign(prisma.pageShare, model(shares));
Object.assign(prisma.bot, model([{ id: "bot-a", ownerId: "user-a", name: "Atlas Vendas" }]));

const app = new Hono();
app.route("/", createPublicPageRoutes());
const get = (token: string) => app.request(`/v1/public/paineis/${token}`);

test("token válido devolve só o que desenha o painel, sem cache e fora dos buscadores", async () => {
	const { token } = (await createOrRotatePageShare("page-a", "user-a"))!;
	const res = await get(token);
	assert.equal(res.status, 200);
	assert.equal(res.headers.get("cache-control"), "no-store");
	assert.match(res.headers.get("x-robots-tag") ?? "", /noindex/);
	assert.equal(res.headers.get("referrer-policy"), "no-referrer");
	const text = await res.text();
	const body = JSON.parse(text) as { page: { title: string; botName: string; spec: unknown } };
	assert.equal(body.page.title, "Vendas");
	assert.equal(body.page.botName, "Atlas Vendas");
	assert.deepEqual(Object.keys(body.page).sort(), ["botName", "spec", "summary", "title", "updatedAt"]);
	for (const secret of ["user-a", "bot-a", "conv-secreta", "crm.interno", "tokenHash"]) assert.ok(!text.includes(secret), `vazou ${secret}`);
});

test("revogado, desconhecido, malformado e painel apagado dão o mesmo 404", async () => {
	const { token } = (await createOrRotatePageShare("page-a", "user-a"))!;
	const unknown = await get("z".repeat(43));
	assert.equal(unknown.status, 404);
	assert.equal((await get("curto")).status, 404);
	assert.equal((await get(`${token}x`)).status, 404);
	await revokePageShare("page-a", "user-a");
	const revoked = await get(token);
	assert.equal(revoked.status, 404);
	assert.deepEqual(await revoked.json(), await unknown.json());
	const again = (await createOrRotatePageShare("page-a", "user-a"))!;
	assert.equal((await get(again.token)).status, 200);
	pages[0]!.deletedAt = new Date();
	assert.equal((await get(again.token)).status, 404);
	pages[0]!.deletedAt = null;
});

test("só GET: outros métodos não leem nem alteram nada", async () => {
	const { token } = (await createOrRotatePageShare("page-a", "user-a"))!;
	for (const method of ["POST", "DELETE", "PATCH"]) assert.equal((await app.request(`/v1/public/paineis/${token}`, { method })).status, 404);
});
