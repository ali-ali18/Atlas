import assert from "node:assert/strict";
import { test } from "node:test";
import { formatPrice } from "../src/price.js";

test("formata 1234.5 com vírgula nos centavos", () => {
	assert.equal(formatPrice(1234.5), "R$ 1234,50");
});

test("formata inteiro com dois zeros", () => {
	assert.equal(formatPrice(10), "R$ 10,00");
});

test("formata zero", () => {
	assert.equal(formatPrice(0), "R$ 0,00");
});
