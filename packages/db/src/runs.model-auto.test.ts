import assert from "node:assert/strict";
import { test } from "node:test";
import { buildQueuedRunData, readRunModelAuto } from "./runs.js";

const request = { messages: [{ role: "user" as const, content: "oi" }] };

test("modo Automático grava no budgetJson e o worker lê de volta", () => {
	const data = buildQueuedRunData({ request, model: "base/m", userId: "u", conversationId: null, modelAuto: true });
	assert.deepEqual(data.budgetJson, { modelAuto: true });
	assert.equal(readRunModelAuto({ budgetJson: data.budgetJson }), true);
	const withWindow = buildQueuedRunData({ request, model: "base/m", userId: "u", conversationId: null, contextLength: 64000, modelAuto: true });
	assert.deepEqual(withWindow.budgetJson, { contextLength: 64000, modelAuto: true });
});

test("sem Automático o budgetJson fica como antes", () => {
	const none = buildQueuedRunData({ request, model: "base/m", userId: "u", conversationId: null });
	assert.equal(none.budgetJson, undefined);
	assert.equal(readRunModelAuto({ budgetJson: none.budgetJson }), false);
	assert.equal(readRunModelAuto({ budgetJson: { modelAuto: "sim" } }), false);
	assert.equal(readRunModelAuto({}), false);
});
