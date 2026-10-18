import assert from "node:assert/strict";
import { test } from "node:test";

process.env.ATLAS_HOOK_PEPPER ||= "p";
process.env.ATLAS_OWNER_EMAIL ||= "o@t.l";

const { pushKindForOrigin, shouldPushRunEnd } = await import("./processors/agent-run.js");

test("fim de run só avisa com conversa, texto, notificador e fora de subagente", () => {
	assert.equal(shouldPushRunEnd({ conversationId: "c1", origin: "chat" }, "Pronto"), true);
	assert.equal(shouldPushRunEnd({ conversationId: null, origin: "chat" }, "Pronto"), false);
	assert.equal(shouldPushRunEnd({ conversationId: "c1", origin: "chat" }, "  \n"), false);
	assert.equal(shouldPushRunEnd({ conversationId: "c1", origin: "subagent" }, "Pronto"), false);
	assert.equal(shouldPushRunEnd({ conversationId: "c1", origin: "chat" }, "Pronto", false), false);
});

test("lembrete, rotina e webhook viram 'lembrete'; conversa normal 'terminou'", () => {
	assert.equal(pushKindForOrigin("proactive"), "reminder");
	assert.equal(pushKindForOrigin("routine"), "reminder");
	assert.equal(pushKindForOrigin("webhook"), "reminder");
	assert.equal(pushKindForOrigin("chat"), "run-finished");
	assert.equal(pushKindForOrigin(undefined), "run-finished");
});
