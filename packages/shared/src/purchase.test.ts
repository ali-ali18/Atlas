import { describe, expect, it } from "vitest";
import { deliveryWatchNote, normalizePurchaseInput, parseConversationCard, purchaseDedupeKey, serializeConversationCard } from "./index.js";

const NOW = new Date("2026-11-07T12:00:00Z");
const base = { merchant: "Loja A", items: [{ name: "Fone", quantity: 1, unitPrice: 199.9 }], total: 219.8, currency: "brl" };

describe("normalizePurchaseInput", () => {
	it("normaliza e usa `now` quando não há data", () => {
		const r = normalizePurchaseInput({ ...base, orderNumber: " 123 ", trackingUrl: "https://rastreio.test/x" }, NOW);
		expect(r).toEqual({ ok: true, value: { merchant: "Loja A", items: [{ name: "Fone", quantity: 1, unitPrice: 199.9 }], total: 219.8, currency: "BRL", purchasedAt: NOW.toISOString(), orderNumber: "123", trackingUrl: "https://rastreio.test/x" } });
	});
	it("recusa com o campo errado: moeda, total, data futura, link não http, item sem nome", () => {
		const err = (patch: Record<string, unknown>) => { const r = normalizePurchaseInput({ ...base, ...patch }, NOW); return r.ok ? "ok" : r.error; };
		expect(err({ currency: "R$" })).toMatch(/currency/);
		expect(err({ total: -1 })).toMatch(/total/);
		expect(err({ purchasedAt: "2027-01-01" })).toMatch(/future/);
		expect(err({ purchasedAt: "ontem" })).toMatch(/ISO/);
		expect(err({ trackingUrl: "javascript:alert(1)" })).toMatch(/trackingUrl/);
		expect(err({ trackingUrl: "https://u:p@x.test/" })).toMatch(/trackingUrl/);
		expect(err({ items: [{ name: "" }] })).toMatch(/items\[0\]\.name/);
		expect(err({ items: [] })).toMatch(/items/);
		expect(err({ merchant: " " })).toMatch(/merchant/);
	});
	it("dedupe: loja + pedido, ou loja + total + dia", () => {
		const a = normalizePurchaseInput({ ...base, orderNumber: "A1" }, NOW);
		const b = normalizePurchaseInput({ ...base, merchant: "loja a", total: 5, orderNumber: "a1" }, NOW);
		if (!a.ok || !b.ok) throw new Error("x");
		expect(purchaseDedupeKey(a.value)).toBe(purchaseDedupeKey(b.value));
		const c = normalizePurchaseInput(base, NOW);
		const d = normalizePurchaseInput({ ...base, total: 220 }, NOW);
		if (!c.ok || !d.ok) throw new Error("x");
		expect(purchaseDedupeKey(c.value)).not.toBe(purchaseDedupeKey(d.value));
	});
});

describe("nota do vigia e cartão", () => {
	it("a nota leva só o que foi dado e cabe no limite da agenda", () => {
		const note = deliveryWatchNote({ merchant: "Loja A", items: [{ name: "Fone", quantity: 1 }], orderNumber: "123", trackingCode: "BR1" });
		expect(note).toContain("order 123");
		expect(note).toContain("tracking code BR1");
		expect(note).not.toContain("tracking page http");
		expect(note.length).toBeLessThanOrEqual(1000);
	});
	it("cartão purchase faz ida e volta", () => {
		const r = normalizePurchaseInput(base, NOW);
		if (!r.ok) throw new Error("x");
		const card = { v: 1 as const, kind: "purchase" as const, purchaseId: "p1", ...r.value };
		expect(parseConversationCard(serializeConversationCard(card))).toMatchObject({ kind: "purchase", purchaseId: "p1", total: 219.8, currency: "BRL" });
		expect(parseConversationCard(JSON.stringify({ ...card, purchaseId: "" }))).toBeNull();
	});
});
