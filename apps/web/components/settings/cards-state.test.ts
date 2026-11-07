import assert from "node:assert/strict";
import test from "node:test";
import { emptyCardForm, formatCardNumberInput, formatExpiryInput, parseExpiry, validateCardForm, type CardForm } from "./cards-state";

const NOW = new Date("2026-11-07T12:00:00Z");
const good: CardForm = { ...emptyCardForm(), number: "4111 1111 1111 1111", holder: "TESTE DA SILVA", expiry: "12/30", line1: "Rua Teste 1", city: "São Paulo", state: "SP", postalCode: "01000-000" };

test("máscaras: número em grupos de 4 e validade com barra automática", () => {
	assert.equal(formatCardNumberInput("4111111111111111"), "4111 1111 1111 1111");
	assert.equal(formatCardNumberInput("41a1-1"), "4111");
	assert.equal(formatExpiryInput("1226"), "12/26");
	assert.equal(formatExpiryInput("12"), "12");
	assert.equal(formatExpiryInput("12/2"), "12/2");
});

test("validade: MM/AA, mês 01 a 12", () => {
	assert.deepEqual(parseExpiry("07/29"), { month: 7, year: 2029 });
	for (const bad of ["7/29", "13/29", "00/29", "07/2029", "07-29", "ab/cd", ""]) assert.equal(parseExpiry(bad), null, bad);
});

test("cartão válido vira o corpo da API sem nenhum campo de CVV", () => {
	const r = validateCardForm(good, NOW);
	assert.equal(r.ok, true);
	if (r.ok) {
		assert.equal(r.input.number, "4111111111111111");
		assert.equal(r.input.expYear, 2030);
		assert.equal(r.input.billing.country, "BR");
		assert.equal(Object.keys(r.input).some((k) => /cvv|cvc|csc/i.test(k)), false);
	}
});

test("erros por campo: Luhn, validade vencida, nome e endereço", () => {
	const bad = validateCardForm({ ...good, number: "4111 1111 1111 1112", expiry: "10/26", holder: "", city: "" }, NOW);
	assert.equal(bad.ok, false);
	if (!bad.ok) assert.deepEqual(Object.keys(bad.errors).sort(), ["billing", "expiry", "holder", "number"]);
	assert.equal(validateCardForm({ ...good, expiry: "11/26" }, NOW).ok, true);
});
