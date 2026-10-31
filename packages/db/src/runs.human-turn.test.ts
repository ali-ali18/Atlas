import assert from "node:assert/strict";
import { test } from "node:test";
import { buildQueuedRunData, readRunHumanTurn } from "./runs.js";

const request = { messages: [{ role: "user" as const, content: "oi" }] };

test("turno humano grava no budgetJson e o worker lê de volta", () => {
	const data = buildQueuedRunData({ request, model: "base/m", userId: "u", conversationId: null, humanTurn: true });
	assert.deepEqual(data.budgetJson, { humanTurn: true });
	assert.equal(readRunHumanTurn({ budgetJson: data.budgetJson }), true);
});

test("run sintético (grupo, proativo, retomada) ou antigo nunca é turno humano", () => {
	const none = buildQueuedRunData({ request, model: "base/m", userId: "u", conversationId: null });
	assert.equal(none.budgetJson, undefined);
	assert.equal(readRunHumanTurn({ budgetJson: none.budgetJson }), false);
	assert.equal(readRunHumanTurn({ budgetJson: { humanTurn: "sim" } }), false);
	assert.equal(readRunHumanTurn({ budgetJson: { modelAuto: true } }), false);
	assert.equal(readRunHumanTurn({}), false);
});
