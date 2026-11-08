import { describe, expect, it } from "vitest";
import { purchaseDay, purchaseMergePatch, deliveryWatchNote, normalizePurchaseInput, parseConversationCard, purchaseDedupeKey, serializeConversationCard } from "./index.js";

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

describe("chave de dedupe (auditoria F6)", () => {
	const key = (raw: Record<string, unknown>, tz?: string, now = NOW) => {
		const r = normalizePurchaseInput({ ...base, ...raw }, now);
		if (!r.ok) throw new Error(r.error);
		return purchaseDedupeKey(r.value, tz);
	};
	it("sem número do pedido, itens diferentes no mesmo dia e total viram duas chaves; ordem e caixa dos itens não importam", () => {
		const a = { items: [{ name: "Fone", quantity: 1 }], total: 100 };
		const b = { items: [{ name: "Mouse", quantity: 1 }], total: 100 };
		expect(key(a)).not.toBe(key(b));
		const two = [{ name: "Fone", quantity: 1 }, { name: "Mouse", quantity: 2 }];
		expect(key({ items: two, total: 9 })).toBe(key({ items: [{ name: " mouse ", quantity: 2 }, { name: "FONE", quantity: 1 }], total: 9 }));
		expect(key({ items: [{ name: "Fone", quantity: 1 }], total: 9 })).not.toBe(key({ items: [{ name: "Fone", quantity: 2 }], total: 9 }));
	});
	it("loja: espaços e caixa não contam; URL vira o domínio; a moeda entra na chave com pedido", () => {
		expect(key({ merchant: "  Loja   A " })).toBe(key({ merchant: "loja a" }));
		expect(key({ merchant: "https://www.Loja.com/x", orderNumber: "1" })).toBe(key({ merchant: "loja.com", orderNumber: " 1 " }));
		expect(key({ orderNumber: "1", currency: "BRL" })).not.toBe(key({ orderNumber: "1", currency: "USD" }));
	});
	it("o dia é o do fuso do dono: compra às 22h em São Paulo (01h UTC do dia seguinte) é a mesma do mesmo dia local", () => {
		const night = "2026-11-07T01:00:00Z"; // 06/11 22h em São Paulo
		const morning = "2026-11-06T13:00:00Z"; // 06/11 10h em São Paulo
		const sp = "America/Sao_Paulo";
		expect(purchaseDay(night, sp)).toBe("2026-11-06");
		expect(purchaseDay(night)).toBe("2026-11-07");
		expect(key({ purchasedAt: night }, sp)).toBe(key({ purchasedAt: morning }, sp));
		expect(key({ purchasedAt: night })).not.toBe(key({ purchasedAt: morning }));
		expect(purchaseDay(night, "Fuso/Invalido")).toBe("2026-11-07");
	});
	it("mescla só o que falta, sem trocar o que já existe", () => {
		expect(purchaseMergePatch({ orderNumber: "A" }, { orderNumber: "B", trackingCode: "BR1", trackingUrl: "https://t.test/1" })).toEqual({ trackingCode: "BR1", trackingUrl: "https://t.test/1" });
		expect(purchaseMergePatch({ trackingCode: "X" }, { trackingCode: "Y" })).toEqual({});
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
