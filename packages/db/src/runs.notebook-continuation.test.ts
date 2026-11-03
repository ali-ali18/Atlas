import assert from "node:assert/strict";
import { test } from "node:test";
import { notebookForContinuation } from "./runs.js";

const notebook = [{ id: "n1", title: "Painel", excerpt: "Entrei no painel" }];

test("o caderno só semeia a continuação se o último run parou com trabalho aberto", () => {
	for (const stop of [{ stopReason: "loop_repeat", stopDetail: "after_note:items_open" }, { stopReason: "budget_steps" }, { stopReason: "answered", stopDetail: "tasklist_open" }]) {
		assert.deepEqual(notebookForContinuation({ ...stop, notebook }), notebook, JSON.stringify(stop));
	}
	// Trabalho já entregue, cancelado ou sem run: o caderno antigo não contamina um pedido novo.
	for (const stop of [{ stopReason: "answered" }, { stopReason: "cancelled" }, { stopReason: null }]) {
		assert.equal(notebookForContinuation({ ...stop, notebook }), null, JSON.stringify(stop));
	}
	assert.equal(notebookForContinuation(undefined), null);
	assert.equal(notebookForContinuation({ stopReason: "loop_repeat", notebook: [] }), null);
	assert.equal(notebookForContinuation({ stopReason: "loop_repeat", notebook: null }), null);
});
