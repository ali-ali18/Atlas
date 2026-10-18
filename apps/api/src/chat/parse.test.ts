import assert from "node:assert/strict";
import { test } from "node:test";
import { API_INPUT_LIMITS } from "./input-limits.js";
import { parseChatCompletionRequest } from "./parse.js";

test("limites de mensagens, conteúdo e maxSteps da entrada compat", () => {
	const message = { role: "user", content: "olá" };
	assert.ok(parseChatCompletionRequest({ messages: [message], maxSteps: 100 }));
	assert.equal(parseChatCompletionRequest({ messages: Array(API_INPUT_LIMITS.messages + 1).fill(message) }), null);
	assert.equal(parseChatCompletionRequest({ messages: [{ ...message, content: "x".repeat(API_INPUT_LIMITS.contentChars + 1) }] }), null);
	for (const maxSteps of [0, -1, 501, 1.5, "10", null]) assert.equal(parseChatCompletionRequest({ messages: [message], maxSteps }), null);
});
