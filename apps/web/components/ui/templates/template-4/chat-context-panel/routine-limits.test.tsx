import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createTranslator } from "@/lib/i18n/translator";
import { draftToLimitsPatch, limitsToDraft, routineLimitsSummary } from "./routine-limits";
import { RoutineLimitsField } from "./routine-limits-field";

Object.assign(globalThis, { React });
const pt = createTranslator("pt-BR");

test("resumo em frase: padrão de 40 passos e sem teto; com teto mostra o valor", () => {
	assert.equal(routineLimitsSummary(undefined, pt), "Até 40 passos por execução · Sem teto de gasto");
	assert.match(routineLimitsSummary({ maxSteps: 60, maxCostUsd: 0.5 }, pt), /^Até 60 passos por execução · Até US\$\s?0,50 por execução$/);
});

test("campos → patch: vazio volta ao padrão (null), vírgula vale, fora da faixa falha no campo certo", () => {
	assert.deepEqual(draftToLimitsPatch({ steps: "", cost: "" }), { ok: true, patch: { maxSteps: null, maxCostUsd: null } });
	assert.deepEqual(draftToLimitsPatch({ steps: " 60 ", cost: "0,5" }), { ok: true, patch: { maxSteps: 60, maxCostUsd: 0.5 } });
	assert.deepEqual(draftToLimitsPatch({ steps: "4", cost: "" }), { ok: false, field: "steps" });
	assert.deepEqual(draftToLimitsPatch({ steps: "201", cost: "" }), { ok: false, field: "steps" });
	assert.deepEqual(draftToLimitsPatch({ steps: "40.5", cost: "" }), { ok: false, field: "steps" });
	assert.deepEqual(draftToLimitsPatch({ steps: "", cost: "51" }), { ok: false, field: "cost" });
	assert.deepEqual(draftToLimitsPatch({ steps: "", cost: "0" }), { ok: false, field: "cost" });
	assert.deepEqual(limitsToDraft({ maxSteps: 60 }), { steps: "60", cost: "" });
});

test("campo recolhido por padrão, com a frase à vista e sem nomes internos", () => {
	const html = renderToStaticMarkup(<RoutineLimitsField limits={{ maxSteps: 60 }} onSave={async () => undefined} />);
	assert.match(html, /Limites por execução/);
	assert.match(html, /Até 60 passos por execução · Sem teto de gasto/);
	assert.match(html, /aria-expanded="false"/);
	assert.doesNotMatch(html, /maxSteps|maxCostUsd|limitsJson/);
});
