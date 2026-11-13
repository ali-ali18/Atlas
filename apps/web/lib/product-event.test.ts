import assert from "node:assert/strict";
import test from "node:test";
import { parseLiveProductEvent } from "./product-event";

const item = (over: Record<string, unknown> = {}) => ({ name: "Fone", merchant: "Loja A", url: "https://a.test/p", price: 100, currency: "BRL", shipping: { kind: "paid", amount: 20 }, total: 1, availability: "in_stock", images: ["https://cdn.a.test/1.jpg", "javascript:alert(1)", "https://127.0.0.1/x.jpg"], ...over });

test("cartão ao vivo recalcula o total, tira foto insegura e recalcula o mais barato (igual ao gravado)", () => {
	const card = parseLiveProductEvent({ cardId: "r:product:1", runId: "r", items: [item(), item({ merchant: "Loja B", url: "https://b.test/p", price: 90, shipping: { kind: "free" }, total: 9999 })] });
	assert.ok(card);
	assert.deepEqual(card.items.map((i) => i.total), [120, 90]);
	assert.deepEqual(card.items[0]!.images, ["https://cdn.a.test/1.jpg"]);
	assert.equal(card.cheapestUrl, "https://b.test/p");
});

test("sem item válido o cartão ao vivo não aparece", () => {
	assert.equal(parseLiveProductEvent({ cardId: "r:product:2", items: [{ name: "" }] }), null);
	assert.equal(parseLiveProductEvent({ cardId: "r:product:3", items: "x" }), null);
});
