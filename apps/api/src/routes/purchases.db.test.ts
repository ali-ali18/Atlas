/**
 * Compras pelas rotas contra Postgres real (F6.5): dois usuários, IDOR e o dado exato.
 * Pulado sem ATLAS_TEST_DB_URL (e DATABASE_URL igual, nome do banco com "test").
 * Runner: ATLAS_TEST_DB_URL=... DATABASE_URL=... NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/routes/purchases.db.test.ts
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { Hono } from "hono";

process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||= "test-secret-long-enough-for-better-auth-middleware";

const url = process.env.ATLAS_TEST_DB_URL?.trim() ?? "";
const skip = !url || !/test/i.test(new URL(url).pathname) || process.env.DATABASE_URL !== url ? "banco de teste ausente (ATLAS_TEST_DB_URL = DATABASE_URL, nome com 'test')" : false;

const { prisma, recordPurchase } = await import("@workspace/db");
const { createPurchaseRoutes } = await import("./purchases.js");

type Env = import("../middleware/auth.js").AuthEnv;
function appFor(userId: string) {
	const app = new Hono<Env>();
	app.use("*", async (c, next) => {
		c.set("session", { user: { id: userId } } as Env["Variables"]["session"]);
		await next();
	});
	app.route("/", createPurchaseRoutes());
	return app;
}
const json = async (r: Response) => (await r.json()) as Record<string, any>;

describe("compras pelas rotas (Postgres real)", { skip }, () => {
	const a = `pur-a-${randomUUID()}`;
	const b = `pur-b-${randomUUID()}`;
	let botA: string;
	let purchaseA: string;

	before(async () => {
		for (const id of [a, b]) await prisma.user.create({ data: { id, name: id, email: `${id}@test.local` } });
		botA = (await prisma.bot.create({ data: { ownerId: a, name: "A" }, select: { id: true } })).id;
		const saved = await recordPurchase({ userId: a, botId: botA, purchase: { merchant: "Loja A", items: [{ name: "Fone", quantity: 2, unitPrice: 99.9 }], total: 219.8, currency: "BRL", purchasedAt: "2026-11-07T10:00:00.000Z", orderNumber: "R-1" } });
		purchaseA = saved.purchase.id;
	});
	after(async () => {
		await prisma.purchase.deleteMany({ where: { userId: { in: [a, b] } } });
		await prisma.bot.deleteMany({ where: { ownerId: { in: [a, b] } } });
		await prisma.user.deleteMany({ where: { id: { in: [a, b] } } });
		await prisma.$disconnect();
	});

	test("o dono lista e lê o dado exato", async () => {
		const list = await json(await appFor(a).request("/v1/purchases"));
		assert.equal(list.purchases.length, 1);
		assert.deepEqual([list.purchases[0].total, list.purchases[0].currency, list.purchases[0].orderNumber], [219.8, "BRL", "R-1"]);
		const one = await appFor(a).request(`/v1/purchases/${purchaseA}`);
		assert.equal(one.status, 200);
		assert.ok(!("deliveryWatchId" in (await json(one)).purchase));
	});

	test("IDOR: B não lista, não lê e não filtra pelo bot de A", async () => {
		const other = appFor(b);
		assert.deepEqual((await json(await other.request("/v1/purchases"))).purchases, []);
		assert.equal((await other.request(`/v1/purchases/${purchaseA}`)).status, 404);
		assert.equal((await other.request(`/v1/purchases?botId=${botA}`)).status, 404);
	});
});
