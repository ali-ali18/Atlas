import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BudgetContinueData } from "@workspace/shared";
import { BudgetContinueCard, type BudgetContinueCardProps } from "./budget-continue-card";

Object.assign(globalThis, { React });

const offer: BudgetContinueData = { offerId: "continue-run-1", runId: "run-1", budgetUsd: 1, status: "pending" };

function render(props: Partial<BudgetContinueCardProps> = {}) {
	return renderToStaticMarkup(<BudgetContinueCard offer={offer} {...props} />);
}

test("pendente: pergunta, valor em dólar, botão com o valor e 'Agora não'; sem termos internos", () => {
	const html = render();
	assert.match(html, /data-kind="budget-continue"/);
	assert.match(html, /Continuar a pesquisa\?/);
	assert.match(html, /Precisa de você/);
	assert.match(html, /Continuar pesquisa \(\+US\$\s1,00\)/);
	assert.match(html, />Agora não</);
	assert.match(html, /Sem o seu ok, nada é gasto/);
	assert.doesNotMatch(html, /budget_cost|create_file|notebook|runId/);
});

test("aplicando trava os botões e mostra 'Retomando…'", () => {
	const html = render({ isApplying: true });
	assert.match(html, /Retomando…/);
	assert.equal((html.match(/<button[^>]*\sdisabled=""/g) ?? []).length, 2);
});

test("aprovado e dispensado: só o selo e uma linha, sem botões", () => {
	const approved = render({ offer: { ...offer, status: "approved", continuationRunId: "run-2" } });
	assert.match(approved, /Pesquisa retomada/);
	assert.match(approved, /Continuando/);
	assert.doesNotMatch(approved, />Agora não</);
	const dismissed = render({ offer: { ...offer, status: "dismissed" } });
	assert.match(dismissed, /Pesquisa não continuada/);
	assert.match(dismissed, /Dispensado/);
	assert.doesNotMatch(dismissed, /Continuar pesquisa \(/);
});

test("erro aparece no card", () => {
	assert.match(render({ error: "Não consegui retomar agora." }), /Não consegui retomar agora\./);
});
