import { test } from "node:test";
import assert from "node:assert/strict";
import { CLIPBOARD_THRESHOLD, needsClipboard, typeWithStrategy } from "./typing.mjs";

function deps(log) {
	return {
		typeDirect: async (t) => log.push(["type", t]),
		setClipboard: async (t) => log.push(["clip", t]),
		pressKey: async (k) => log.push(["key", k]),
	};
}

test("needsClipboard: limite de 200 caracteres, tab e quebra de linha", () => {
	assert.equal(needsClipboard("a".repeat(CLIPBOARD_THRESHOLD)), false);
	assert.equal(needsClipboard("a".repeat(CLIPBOARD_THRESHOLD + 1)), true);
	assert.equal(needsClipboard("a\tb"), true);
	assert.equal(needsClipboard("linha1\nlinha2"), true);
	assert.equal(needsClipboard(""), false);
});

test("texto curto digita direto", async () => {
	const log = [];
	assert.deepEqual(await typeWithStrategy("oi", deps(log)), { method: "xdotool" });
	assert.deepEqual(log, [["type", "oi"]]);
});

test("TSV longo vai por clipboard + ctrl+v, sem xdotool type", async () => {
	const log = [];
	const tsv = Array.from({ length: 30 }, (_, i) => `a${i}\tb${i}`).join("\n");
	assert.deepEqual(await typeWithStrategy(tsv, deps(log)), { method: "clipboard" });
	assert.deepEqual(log, [["clip", tsv], ["key", "ctrl+v"]]);
});
