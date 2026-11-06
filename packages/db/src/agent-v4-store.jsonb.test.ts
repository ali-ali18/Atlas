import assert from "node:assert/strict";
import { test } from "node:test";
import { agentV4ProvenanceOf, jsonbSafe } from "./agent-v4-store.js";

test("jsonbSafe troca NUL e surrogate solto no JSON do checkpoint (reauditoria F1, N4)", () => {
	const payload = { lastText: "a\u0000b", args: { q: "x\ud800y", r: "\udc00z" }, ok: "emoji 😀", literal: "\\u0000" };
	const out = jsonbSafe(JSON.stringify(payload));
	assert.ok(!/(^|[^\\])\\u0000/.test(out));
	const back = JSON.parse(out) as typeof payload;
	assert.equal(back.lastText, "a\ufffdb");
	assert.equal(back.args.q, "x\ufffdy");
	assert.equal(back.args.r, "\ufffdz");
	assert.equal(back.ok, "emoji 😀");
	assert.equal(back.literal, "\\u0000");
});

test("agentV4ProvenanceOf: pega só os sinais (sem os textos indexados); formato inesperado vira null (C1)", () => {
	assert.deepEqual(agentV4ProvenanceOf({ provenance: { untrustedReadInRun: true, sources: ["web", 7, "mail"], texts: ["grande"] } }), { untrustedReadInRun: true, privateReadInRun: false, sources: ["web", "mail"] });
	assert.deepEqual(agentV4ProvenanceOf({ provenance: { untrustedReadInRun: false, privateReadInRun: true, sources: [] } }), { untrustedReadInRun: false, privateReadInRun: true, sources: [] });
	for (const bad of [null, undefined, "x", {}, { provenance: null }, { provenance: "x" }]) assert.equal(agentV4ProvenanceOf(bad), null);
});
