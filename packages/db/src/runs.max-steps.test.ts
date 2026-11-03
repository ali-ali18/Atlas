import assert from "node:assert/strict";
import { test } from "node:test";
import { RUN_MAX_STEPS } from "@workspace/shared";
import { buildQueuedRunData } from "./runs.js";

const messages = [{ role: "user" as const, content: "oi" }];
const build = (maxSteps?: number) => buildQueuedRunData({ request: { messages, ...(maxSteps !== undefined ? { maxSteps } : {}) }, model: "base/m", userId: "u", conversationId: null });

test("o padrão do run é o limite de segurança do motor (200), não mais 100", () => {
	assert.equal(RUN_MAX_STEPS, 200);
	assert.equal(build().maxSteps, 200);
});

test("o pedido pode baixar o limite, mas nunca passar de 200 nem ficar abaixo de 1", () => {
	assert.equal(build(50).maxSteps, 50);
	assert.equal(build(200).maxSteps, 200);
	assert.equal(build(500).maxSteps, 200);
	assert.equal(build(0).maxSteps, 1);
});
