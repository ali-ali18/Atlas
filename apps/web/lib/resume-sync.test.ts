import assert from "node:assert/strict";
import { test } from "node:test";
import { isStreamIdle, newMessagesSince, shouldResync } from "./resume-sync";

test("stream ocioso só depois do limite", () => {
	assert.equal(isStreamIdle(1000, 1000 + 39_000), false);
	assert.equal(isStreamIdle(1000, 1000 + 40_000), true);
});

test("voltar de segundo plano longo ressincroniza; curto não", () => {
	const base = { lastResyncAt: 0, now: 100_000 };
	assert.equal(shouldResync({ ...base, signal: "visible", hiddenAt: 90_000 }), true);
	assert.equal(shouldResync({ ...base, signal: "focus", hiddenAt: 99_500 }), false);
	assert.equal(shouldResync({ ...base, signal: "visible", hiddenAt: null }), false);
});

test("pageshow só quando restaurado do bfcache; online sempre", () => {
	const base = { lastResyncAt: 0, now: 100_000, hiddenAt: null };
	assert.equal(shouldResync({ ...base, signal: "pageshow", persisted: false }), false);
	assert.equal(shouldResync({ ...base, signal: "pageshow", persisted: true }), true);
	assert.equal(shouldResync({ ...base, signal: "online" }), true);
});

test("sinais colados são deduplicados", () => {
	assert.equal(shouldResync({ signal: "online", now: 10_000, hiddenAt: null, lastResyncAt: 9_500 }), false);
});

test("mescla sem duplicar e sem perder as novas", () => {
	const known = [{ id: "a" }, { id: "b" }];
	const fetched = [{ id: "b" }, { id: "c" }, { id: "c" }, { id: "d" }];
	assert.deepEqual(newMessagesSince(known, fetched), [{ id: "c" }, { id: "d" }]);
	assert.deepEqual(newMessagesSince(known, known), []);
});
