import assert from "node:assert/strict";
import { test } from "node:test";
import { withFinalReply } from "./runs.js";

const cp = { version: 2, llmMessages: [{ role: "user", content: "oi" }, { role: "tool", tool_call_id: "a", content: "r" }] };

test("a resposta final entra no fim da conversa gravada do run", () => {
	const next = withFinalReply(cp, " pronto ")!;
	assert.deepEqual(next.llmMessages, [...cp.llmMessages, { role: "assistant", content: "pronto" }]);
	assert.equal(cp.llmMessages.length, 2);
});

test("sem texto, sem conversa gravada ou resposta já presente: nada a anexar", () => {
	assert.equal(withFinalReply(cp, "  "), null);
	assert.equal(withFinalReply({ version: 2 }, "x"), null);
	assert.equal(withFinalReply(null, "x"), null);
	assert.equal(withFinalReply({ llmMessages: [{ role: "assistant", content: "x" }] }, "x"), null);
});
