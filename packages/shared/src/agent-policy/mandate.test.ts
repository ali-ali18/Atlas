import { describe, expect, it } from "vitest";
import { checkMandate, type Mandate } from "./mandate.js";

const now = new Date("2026-11-05T12:00:00Z");
const base: Mandate = { maxAmount: 100, currency: "BRL", merchants: ["loja-a", "Loja-B"], until: "2026-11-06T00:00:00Z", usesLeft: 2 };
const buy = { amount: 50, currency: "BRL", merchant: "loja-a", now };

describe("checkMandate", () => {
	it.each([
		["compra dentro do mandato", {}, base, true],
		["valor exatamente no teto", { amount: 100 }, base, true],
		["loja casa sem diferenciar caixa", { merchant: "loja-b" }, base, true],
	])("%s", (_n, over, mandate, ok) => {
		expect(checkMandate(mandate, { ...buy, ...over }).ok).toBe(ok);
	});

	it.each([
		["um centavo acima do teto", { amount: 100.01 }, base, "amount_exceeded"],
		["loja fora da lista", { merchant: "loja-c" }, base, "merchant_not_allowed"],
		["loja vazia", { merchant: " " }, base, "merchant_not_allowed"],
		["lista de lojas vazia", {}, { ...base, merchants: [] }, "merchant_not_allowed"],
		["moeda diferente", { currency: "USD" }, base, "currency_mismatch"],
		["vencido (now == until)", { now: new Date("2026-11-06T00:00:00Z") }, base, "expired"],
		["vencido (depois)", { now: new Date("2026-12-01T00:00:00Z") }, base, "expired"],
		["until ilegível", {}, { ...base, until: "ontem" }, "expired"],
		["sem usos", {}, { ...base, usesLeft: 0 }, "no_uses_left"],
		["usos negativos", {}, { ...base, usesLeft: -1 }, "no_uses_left"],
		["valor negativo", { amount: -1 }, base, "invalid_amount"],
		["valor NaN", { amount: Number.NaN }, base, "invalid_amount"],
	])("rejeita: %s", (_n, over, mandate, reason) => {
		expect(checkMandate(mandate, { ...buy, ...over })).toEqual({ ok: false, reason });
	});
});
