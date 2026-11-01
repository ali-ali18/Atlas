import assert from "node:assert/strict";
import test from "node:test";
import { formatBudgetUsd, parseBudgetMinutes, parseBudgetUsd } from "./engine-settings";

test("orçamento em dólar: vírgula ou ponto, faixa de 0,05 a 20", () => {
	assert.equal(parseBudgetUsd("1"), 1);
	assert.equal(parseBudgetUsd("0,5"), 0.5);
	assert.equal(parseBudgetUsd("US$ 2.25"), 2.25);
	for (const bad of ["", "abc", "0", "0,01", "21", "-1", "1,2,3"]) assert.equal(parseBudgetUsd(bad), null, bad);
});

test("minutos: inteiro de 1 a 120", () => {
	assert.equal(parseBudgetMinutes("20"), 20);
	assert.equal(parseBudgetMinutes("20 min"), 20);
	for (const bad of ["0", "121", "", "x"]) assert.equal(parseBudgetMinutes(bad), null, bad);
});

test("formata em pt-BR", () => assert.equal(formatBudgetUsd(0.5), "0,50"));
