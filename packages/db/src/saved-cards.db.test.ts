/**
 * Cartões salvos e mandato contra Postgres real (F6.2/F6.4). Pulado sem ATLAS_TEST_DB_URL.
 * Cobre caminho feliz, limite, mandato e o acesso de OUTRO dono (40-seguranca). O texto selado é opaco aqui.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { prisma } from "./client.js";
import { consumePurchaseMandateUse, createSavedCard, deletePurchaseMandate, deleteSavedCard, getPurchaseMandate, getSavedCardMeta, getSavedCardSealed, listSavedCards, lowerPurchaseMandateUses, restorePurchaseMandateUse, SAVED_CARDS_MAX_PER_OWNER, SavedCardLimitError, upsertPurchaseMandate } from "./saved-cards.js";
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

	test("limite por dono: criações concorrentes não passam do teto", async () => {
		const d = (await createTestUser("sccrace")).id;
		const input = (i: number) => ({ label: `c${i}`, brand: "visa", last4: "1111", secretsEnc: "x" });
		for (let i = 0; i < SAVED_CARDS_MAX_PER_OWNER - 2; i++) await createSavedCard(d, input(i));
		const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => createSavedCard(d, input(100 + i))));
		assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
		assert.ok(results.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason instanceof SavedCardLimitError));
		assert.equal((await listSavedCards(d)).length, SAVED_CARDS_MAX_PER_OWNER);
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

	test("mandato: a loja é gravada normalizada (como o checkout compara) e entrada inválida é recusada", async () => {
		const until = new Date("2099-12-01T00:00:00Z");
		const m = await upsertPurchaseMandate(a, { maxAmount: 10, currency: "BRL", merchants: ["https://www.Loja.Test/x", "loja.test", "lojá.com.br"], until, uses: 1 });
		assert.deepEqual(m.merchants, ["loja.test", "xn--loj-gla.com.br"]);
		await assert.rejects(() => upsertPurchaseMandate(a, { maxAmount: 10, currency: "BRL", merchants: ["loja.test", "lixo"], until, uses: 1 }), RangeError);
		assert.deepEqual((await getPurchaseMandate(a))?.merchants, ["loja.test", "xn--loj-gla.com.br"], "recusa não altera o mandato");
		await deletePurchaseMandate(a);
	});

	test("mandato: lojas antigas (gravadas sem normalizar) são normalizadas na leitura e as ilegíveis descartadas", async () => {
		const until = new Date("2099-12-01T00:00:00Z");
		await upsertPurchaseMandate(a, { maxAmount: 10, currency: "BRL", merchants: ["loja.test"], until, uses: 1 });
		await prisma.purchaseMandate.update({ where: { userId: a }, data: { merchants: ["Https://WWW.Loja.Test/", "loja.test", "lixo sem dominio", "www.Outra.com.br/"] } });
		assert.deepEqual((await getPurchaseMandate(a))?.merchants, ["loja.test", "outra.com.br"]);
		await deletePurchaseMandate(a);
	});

	test("mandato: gasto de uso atômico, duas chamadas concorrentes com 1 uso passam só uma", async () => {
		const until = new Date("2099-12-01T00:00:00Z");
		await upsertPurchaseMandate(a, { maxAmount: 300, currency: "BRL", merchants: ["loja.test"], until, uses: 1 });
		const results = await Promise.all(Array.from({ length: 8 }, () => consumePurchaseMandateUse(a)));
		assert.equal(results.filter(Boolean).length, 1);
		assert.equal((await getPurchaseMandate(a))?.usesLeft, 0);
		assert.equal(await consumePurchaseMandateUse(a), false);
		assert.equal((await getPurchaseMandate(a))?.usesLeft, 0, "nunca fica negativo");
		await restorePurchaseMandateUse(a);
		assert.equal((await getPurchaseMandate(a))?.usesLeft, 1);
	});

	test("mandato: vencido, inexistente ou de outro dono não gasta uso", async () => {
		await upsertPurchaseMandate(a, { maxAmount: 300, currency: "BRL", merchants: ["loja.test"], until: new Date("2020-01-01T00:00:00Z"), uses: 3 });
		assert.equal(await consumePurchaseMandateUse(a), false);
		assert.equal(await consumePurchaseMandateUse(b), false);
		assert.equal(await consumePurchaseMandateUse(""), false);
		assert.equal((await getPurchaseMandate(a))?.usesLeft, 3);
		await deletePurchaseMandate(a);
	});
});
