/**
 * Compras do dono contra Postgres real (F6.5): gravar, dedupe, escopo por dono (IDOR) e cartão na conversa.
 * Pulado sem ATLAS_TEST_DB_URL. Runner: `pnpm --filter @workspace/db test:db`.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { normalizePurchaseInput, type PurchaseInput } from "@workspace/shared";
import { prisma } from "./client.js";
import { persistConversationCardFromEvent } from "./conversations.js";
import { attachDeliveryWatch, getPurchase, listPurchases, recordPurchase } from "./purchases.js";
import { createTestBot, createTestUser, dbSkip } from "./testing/test-db.js";

const NOW = new Date("2026-11-07T12:00:00Z");
const make = (over: Record<string, unknown> = {}): PurchaseInput => {
	const r = normalizePurchaseInput({ merchant: "Loja A", items: [{ name: "Fone", quantity: 2, unitPrice: 99.9 }], total: 219.8, currency: "BRL", orderNumber: `P-${Math.random()}`, ...over }, NOW);
	assert.ok(r.ok);
	return r.value;
};

describe("compras (Postgres real)", { skip: dbSkip }, () => {
	let userA: string;
	let userB: string;
	let botA: string;

	before(async () => {
		userA = (await createTestUser("pur-a")).id;
		userB = (await createTestUser("pur-b")).id;
		botA = (await createTestBot(userA, { name: "compras" })).id;
	});
	after(async () => {
		await prisma.$disconnect();
	});

	test("grava com valores exatos e lê de volta (total decimal, itens, rastreio)", async () => {
		const { purchase, duplicate } = await recordPurchase({ userId: userA, botId: botA, sourceRunId: "run-1", purchase: make({ trackingCode: "BR123", trackingUrl: "https://rastreio.test/BR123" }) });
		assert.equal(duplicate, false);
		assert.equal(purchase.total, 219.8);
		assert.deepEqual(purchase.items, [{ name: "Fone", quantity: 2, unitPrice: 99.9 }]);
		assert.equal(purchase.botId, botA);
		assert.equal(purchase.trackingCode, "BR123");
		assert.equal((await getPurchase(userA, purchase.id))?.id, purchase.id);
	});

	test("o mesmo pedido duas vezes não duplica (inclusive em corrida)", async () => {
		const input = make({ orderNumber: "DUP-1" });
		const results = await Promise.all([recordPurchase({ userId: userA, purchase: input }), recordPurchase({ userId: userA, purchase: input }), recordPurchase({ userId: userA, purchase: input })]);
		assert.equal(new Set(results.map((r) => r.purchase.id)).size, 1);
		assert.equal(results.filter((r) => !r.duplicate).length, 1);
		// Outro dono pode ter o mesmo número de pedido.
		const other = await recordPurchase({ userId: userB, purchase: input });
		assert.equal(other.duplicate, false);
	});

	test("IDOR: o usuário B não lê, não lista nem liga vigia à compra do usuário A", async () => {
		const { purchase } = await recordPurchase({ userId: userA, purchase: make() });
		assert.equal(await getPurchase(userB, purchase.id), null);
		assert.ok(!(await listPurchases(userB)).some((p) => p.id === purchase.id));
		assert.equal(await attachDeliveryWatch(userB, purchase.id, "w-x"), false);
		assert.equal((await getPurchase(userA, purchase.id))?.deliveryWatchId, null);
		assert.equal(await attachDeliveryWatch(userA, purchase.id, "w-1"), true);
		assert.equal((await getPurchase(userA, purchase.id))?.deliveryWatchId, "w-1");
	});

	test("lista: mais recente primeiro e filtro por bot", async () => {
		const u = (await createTestUser("pur-list")).id;
		const b = (await createTestBot(u, { name: "x" })).id;
		await recordPurchase({ userId: u, botId: b, purchase: make({ purchasedAt: "2026-10-01", orderNumber: "L1" }) });
		await recordPurchase({ userId: u, purchase: make({ purchasedAt: "2026-11-01", orderNumber: "L2" }) });
		const all = await listPurchases(u);
		assert.deepEqual(all.map((p) => p.orderNumber), ["L2", "L1"]);
		assert.deepEqual((await listPurchases(u, { botId: b })).map((p) => p.orderNumber), ["L1"]);
	});

	test("cartões product e purchase entram na conversa uma vez por identidade", async () => {
		const conversationId = (await prisma.conversation.create({ data: { userId: userA } })).id;
		const product = { type: "product", cardId: "run-9:product:abc", runId: "run-9", items: [{ name: "Fone", merchant: "Loja A", url: "https://a.test/p", price: 10, currency: "BRL", shipping: { kind: "free" }, total: 10, availability: "in_stock", images: [] }] };
		await persistConversationCardFromEvent(conversationId, product);
		await persistConversationCardFromEvent(conversationId, product);
		const purchase = { type: "purchase", purchaseId: "pur-1", merchant: "Loja A", items: [{ name: "Fone", quantity: 1 }], total: 10, currency: "BRL", purchasedAt: NOW.toISOString() };
		await persistConversationCardFromEvent(conversationId, purchase);
		await persistConversationCardFromEvent(conversationId, purchase);
		const rows = await prisma.conversationMessage.findMany({ where: { conversationId }, select: { role: true } });
		assert.deepEqual(rows.map((r) => r.role).sort(), ["product", "purchase"]);
	});
});
