import { describe, expect, it } from "vitest";
import { cardExpiryValid, detectCardBrand, isValidCvv, luhnValid, normalizeCardNumber, purchaseMandateInputSchema, validateSavedCardInput } from "./payment-card.js";

const NOW = new Date("2026-11-07T12:00:00Z");
const billing = { line1: "Rua Teste 1", city: "São Paulo", state: "SP", postalCode: "01000-000", country: "br" };
const base = { number: "4111 1111 1111 1111", holder: "TESTE DA SILVA", expMonth: 12, expYear: 2030, billing };

describe("payment-card", () => {
	it("Luhn: números de teste públicos passam, alterados não", () => {
		expect(luhnValid("4111111111111111")).toBe(true);
		expect(luhnValid("5555555555554444")).toBe(true);
		expect(luhnValid("4111111111111112")).toBe(false);
		expect(luhnValid("")).toBe(false);
		expect(luhnValid("41a1")).toBe(false);
	});
	it("bandeira por prefixo", () => {
		expect(detectCardBrand("4111111111111111")).toBe("visa");
		expect(detectCardBrand("5555555555554444")).toBe("mastercard");
		expect(detectCardBrand("378282246310005")).toBe("amex");
		expect(detectCardBrand("9999999999999995")).toBe("unknown");
	});
	it("validade: mês corrente vale até o fim; passado não; mês 13 não", () => {
		expect(cardExpiryValid(11, 2026, NOW)).toBe(true);
		expect(cardExpiryValid(10, 2026, NOW)).toBe(false);
		expect(cardExpiryValid(13, 2027, NOW)).toBe(false);
		expect(cardExpiryValid(1, 27, NOW)).toBe(true);
	});
	it("CVV: 3 ou 4 dígitos", () => {
		expect(isValidCvv("123")).toBe(true);
		expect(isValidCvv("1234")).toBe(true);
		expect(isValidCvv("12")).toBe(false);
		expect(isValidCvv("12345")).toBe(false);
		expect(isValidCvv("12a")).toBe(false);
		expect(isValidCvv(123)).toBe(false);
	});
	it("valida e extrai final e bandeira", () => {
		const r = validateSavedCardInput(base, NOW);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.card.last4).toBe("1111");
			expect(r.card.brand).toBe("visa");
			expect(r.card.label).toBe("Visa final 1111");
			expect(r.card.secrets.number).toBe("4111111111111111");
			expect(r.card.secrets.billing.country).toBe("BR");
		}
		expect(normalizeCardNumber("4111-1111 1111")).toBe("411111111111");
	});
	it("recusa Luhn, validade vencida e campo de CVV (não existe)", () => {
		expect(validateSavedCardInput({ ...base, number: "4111 1111 1111 1112" }, NOW).ok).toBe(false);
		expect(validateSavedCardInput({ ...base, expYear: 2025 }, NOW).ok).toBe(false);
		for (const field of ["cvv", "cvc", "csc"]) expect(validateSavedCardInput({ ...base, [field]: "123" }, NOW).ok).toBe(false);
	});
	it("a mensagem de erro nunca repete o número", () => {
		const r = validateSavedCardInput({ ...base, number: "4111 1111 1111 1112" }, NOW);
		expect(JSON.stringify(r)).not.toContain("4111");
	});
	it("mandato: corpo estrito", () => {
		const ok = { maxAmount: 300, currency: "BRL", merchants: ["loja.test"], until: "2026-12-01T00:00:00Z", uses: 2 };
		expect(purchaseMandateInputSchema.safeParse(ok).success).toBe(true);
		expect(purchaseMandateInputSchema.safeParse({ ...ok, merchants: [] }).success).toBe(false);
		expect(purchaseMandateInputSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
	});
});
