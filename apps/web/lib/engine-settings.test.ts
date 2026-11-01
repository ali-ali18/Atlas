import assert from "node:assert/strict";
import test from "node:test";
import { budgetBlurAction, formatBudgetUsd, parseBudgetMinutes, parseBudgetUsd } from "./engine-settings";

test("orçamento em dólar: vírgula ou ponto, faixa de 0,05 a 20", () => {
	assert.equal(parseBudgetUsd("1"), 1);
	assert.equal(parseBudgetUsd("0,5"), 0.5);
	assert.equal(parseBudgetUsd("US$ 2.25"), 2.25);
	for (const bad of ["", "abc", "0", "0,01", "21", "-1", "1,2,3"]) assert.equal(parseBudgetUsd(bad), null, bad);
});

test("minutos: inteiro de 1 a 180", () => {
	assert.equal(parseBudgetMinutes("20"), 20);
	assert.equal(parseBudgetMinutes("20 min"), 20);
	assert.equal(parseBudgetMinutes("180"), 180);
	for (const bad of ["0", "181", "", "x"]) assert.equal(parseBudgetMinutes(bad), null, bad);
});

test("formata em pt-BR", () => assert.equal(formatBudgetUsd(0.5), "0,50"));

test("blur do campo: Esc cancela, igual ao salvo não salva, texto novo salva", () => {
	assert.equal(budgetBlurAction({ draft: "50", saved: "0,50", cancelled: true }), "skip");
	assert.equal(budgetBlurAction({ draft: "0,50", saved: "0,50", cancelled: false }), "skip");
	assert.equal(budgetBlurAction({ draft: "1", saved: "0,50", cancelled: false }), "commit");
});
