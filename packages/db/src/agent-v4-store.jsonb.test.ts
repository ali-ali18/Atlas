import assert from "node:assert/strict";
import { test } from "node:test";
import { jsonbSafe } from "./agent-v4-store.js";

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
