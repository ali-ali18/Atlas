import assert from "node:assert/strict";
import { test } from "node:test";
import { buildQueuedRunData } from "./runs.js";

const request = { messages: [{ role: "user" as const, content: "oi" }] };
const base = { model: "base/m", userId: "u", conversationId: null };

test("o nível do chat vai para o budgetJson do run (retomada e turnos encadeados mantêm)", () => {
	const data = buildQueuedRunData({ ...base, request: { ...request, reasoningEffort: "low" } });
	assert.deepEqual(data.budgetJson, { reasoningEffort: "low" });
	const withOthers = buildQueuedRunData({ ...base, request: { ...request, reasoningEffort: "off" }, contextLength: 64000, modelAuto: true });
	assert.deepEqual(withOthers.budgetJson, { contextLength: 64000, modelAuto: true, reasoningEffort: "off" });
});

test("sem nível (ou valor inválido) o budgetJson fica como antes", () => {
	assert.equal(buildQueuedRunData({ ...base, request }).budgetJson, undefined);
	const invalid = { ...request, reasoningEffort: "extreme" } as unknown as typeof request;
	assert.equal(buildQueuedRunData({ ...base, request: invalid }).budgetJson, undefined);
});
