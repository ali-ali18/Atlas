import { test } from "node:test";
import assert from "node:assert/strict";
import {
	isGenericSelector,
	planClickTarget,
	planTypeTarget,
	pickTextMatch,
	planClick,
	compactPlaywrightError,
	explainFillError,
} from "./target.mjs";

test("isGenericSelector: só tag pura é genérica", () => {
	for (const s of ["a", "button", "DIV", " span ", "input", "*", "a:first-child", "li:nth-child(2)"]) {
		assert.equal(isGenericSelector(s), true, s);
	}
	for (const s of ["#login", "button[type=submit]", "a.menu", ".btn", "[data-atlas-ref=\"e3\"]", "form input", "", undefined]) {
		assert.equal(isGenericSelector(s), false, String(s));
	}
});

test("planClickTarget: text vence selector genérico (caso Bling)", () => {
	assert.deepEqual(planClickTarget({ text: "Incluir proposta", selector: "a" }), {
		mode: "text",
		text: "Incluir proposta",
		scope: "a",
	});
});

test("planClickTarget: selector genérico sozinho é rejeitado com dica", () => {
	assert.throws(() => planClickTarget({ selector: "a" }), /browser_snapshot/);
	assert.throws(() => planClickTarget({ selector: "button" }), /genérico/);
});

test("planClickTarget: seletor específico e vazio", () => {
	assert.deepEqual(planClickTarget({ selector: "#salvar" }), { mode: "selector", selector: "#salvar" });
	assert.throws(() => planClickTarget({}), /obrigatório/);
	assert.throws(() => planClickTarget({ selector: "  ", text: "  " }), /obrigatório/);
});

test("planTypeTarget: foco, específico e genérico", () => {
	assert.deepEqual(planTypeTarget({}), { mode: "focus" });
	assert.deepEqual(planTypeTarget({ selector: "input[name=q]" }), { mode: "selector", selector: "input[name=q]" });
	assert.throws(() => planTypeTarget({ selector: "input" }), /browser_snapshot/);
});

test("pickTextMatch: exato vence parcial; ignora invisíveis", () => {
	const items = [
		{ text: "Incluir proposta comercial", visible: true },
		{ text: "Incluir proposta", visible: false },
		{ text: "  incluir   PROPOSTA ", visible: true },
	];
	assert.deepEqual(pickTextMatch(items, "Incluir proposta"), { index: 2, exact: true, ambiguous: false, matches: 1 });
	const partial = pickTextMatch(items, "proposta comercial");
	assert.equal(partial.index, 0);
	assert.equal(partial.exact, false);
	assert.equal(pickTextMatch(items, "outro"), null);
	assert.equal(pickTextMatch([{ text: "Salvar" }, { text: "Salvar" }], "salvar").ambiguous, true);
});

test("explainFillError: alvo que não é campo vira dica", () => {
	assert.match(explainFillError("Error: Element is not an <input>, <textarea> or [contenteditable]"), /browser_snapshot/);
	assert.equal(explainFillError("Timeout 15000ms"), "Timeout 15000ms");
});

test("planClick: prefere o candidato com ancestral interativo e conta o card como um alvo", () => {
	const candidates = [
		{ text: "Cálculo I", visible: true, interactive: false },
		{ text: "Cálculo I", visible: true, interactive: true, group: "g0" },
		{ text: "Cálculo I", visible: true, interactive: true, group: "g0" },
	];
	const pick = planClick(candidates, "cálculo i");
	assert.equal(pick.index, 1);
	assert.equal(pick.interactive, true);
	assert.equal(pick.exact, true);
	assert.equal(pick.matches, 2); // o nó solto + o card (g0) — não 3
	assert.equal(planClick([{ text: "x", visible: false }], "x"), null);
});

test("planClick: sem informação de interatividade mantém a ordem do DOM", () => {
	const pick = planClick([{ text: "Salvar tudo", visible: true }, { text: "Salvar", visible: true }], "salvar");
	assert.equal(pick.index, 1); // exato vence o parcial
	assert.equal(pick.interactive, false);
});

test("compactPlaywrightError: corta o call log e limita a 300 caracteres", () => {
	const step = "  - waiting for element to be visible, enabled and stable";
	const raw = ["locator.click: Timeout 15000ms exceeded.", "Call log:", ...Array(60).fill(step)].join("\n");
	const out = compactPlaywrightError(raw);
	assert.equal(out, "locator.click: Timeout 15000ms exceeded.");
	assert.ok(compactPlaywrightError("a".repeat(900)).length <= 300);
	assert.ok(raw.length > 2000);
});
