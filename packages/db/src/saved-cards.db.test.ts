/**
 * Cartões salvos e mandato contra Postgres real (F6.2/F6.4). Pulado sem ATLAS_TEST_DB_URL.
 * Cobre caminho feliz, limite, mandato e o acesso de OUTRO dono (40-seguranca). O texto selado é opaco aqui.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { prisma } from "./client.js";
import { createSavedCard, deletePurchaseMandate, deleteSavedCard, getPurchaseMandate, getSavedCardMeta, getSavedCardSealed, listSavedCards, lowerPurchaseMandateUses, SAVED_CARDS_MAX_PER_OWNER, SavedCardLimitError, upsertPurchaseMandate } from "./saved-cards.js";
import { createTestUser, dbSkip } from "./testing/test-db.js";

describe("saved-cards (Postgres real)", { skip: dbSkip }, () => {
	let a: string;
	let b: string;
	let cardA: string;
	before(async () => {
		a = (await createTestUser("sca")).id;
		b = (await createTestUser("scb")).id;
		cardA = (await createSavedCard(a, { label: "Visa final 1111", brand: "visa", last4: "1111", secretsEnc: "v1:aaa:bbb:ccc" })).id;
	});
	after(async () => {
		await prisma.$disconnect();
	});

	test("a lista traz só rótulo, bandeira e final (nunca o texto selado)", async () => {
		const rows = await listSavedCards(a);
		assert.equal(rows.length, 1);
		assert.deepEqual(Object.keys(rows[0]!).sort(), ["brand", "createdAt", "id", "label", "last4"]);
		assert.equal(JSON.stringify(rows).includes("v1:aaa"), false);
	});

	test("outro dono: não lista, não lê metadado, não lê o selado, não apaga", async () => {
		assert.deepEqual(await listSavedCards(b), []);
		assert.equal(await getSavedCardMeta(b, cardA), null);
		assert.equal(await getSavedCardSealed(b, cardA), null);
		assert.equal(await deleteSavedCard(b, cardA), false);
		assert.ok(await getSavedCardSealed(a, cardA));
	});

	test("dono vazio ou 'default' não enxerga nada", async () => {
		assert.deepEqual(await listSavedCards("default"), []);
		assert.equal(await getSavedCardSealed("", cardA), null);
	});

	test("limite por dono e apagar", async () => {
		const c = (await createTestUser("scc")).id;
		for (let i = 0; i < SAVED_CARDS_MAX_PER_OWNER; i++) await createSavedCard(c, { label: `c${i}`, brand: "visa", last4: "1111", secretsEnc: "x" });
		await assert.rejects(() => createSavedCard(c, { label: "extra", brand: "visa", last4: "1111", secretsEnc: "x" }), SavedCardLimitError);
		const [first] = await listSavedCards(c);
		assert.equal(await deleteSavedCard(c, first!.id), true);
		assert.equal(await deleteSavedCard(c, first!.id), false);
	});

	test("mandato: um por dono, só diminui usos, isolado entre donos", async () => {
		const until = new Date("2026-12-01T00:00:00Z");
		await upsertPurchaseMandate(a, { maxAmount: 300, currency: "brl", merchants: ["Loja.Test"], until, uses: 3 });
		const m = await getPurchaseMandate(a);
		assert.equal(m?.currency, "BRL");
		assert.deepEqual(m?.merchants, ["loja.test"]);
		assert.equal(await getPurchaseMandate(b), null);
		await lowerPurchaseMandateUses(a, 1);
		await lowerPurchaseMandateUses(a, 2);
		assert.equal((await getPurchaseMandate(a))?.usesLeft, 1);
		await lowerPurchaseMandateUses(b, 0);
		assert.equal(await deletePurchaseMandate(b), false);
		assert.equal(await deletePurchaseMandate(a), true);
	});
});
