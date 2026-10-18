import assert from "node:assert/strict";
import test from "node:test";
import { composerEnterAction } from "./composer-keys";

const base = { shift: false, mentionOpen: false, hasCandidates: false };

test("popup aberto com candidatos seleciona, em desktop e toque, com ou sem shift", () => {
	for (const touch of [false, true]) {
		assert.equal(composerEnterAction({ ...base, touch, mentionOpen: true, hasCandidates: true }), "pick-mention");
		assert.equal(composerEnterAction({ ...base, touch, shift: true, mentionOpen: true, hasCandidates: true }), "pick-mention");
	}
});

test("desktop: Enter envia e Shift+Enter quebra linha", () => {
	assert.equal(composerEnterAction({ ...base, touch: false }), "send");
	assert.equal(composerEnterAction({ ...base, touch: false, shift: true }), "newline");
});

test("desktop: popup aberto sem candidatos ainda envia", () => {
	assert.equal(composerEnterAction({ ...base, touch: false, mentionOpen: true }), "send");
});

test("toque: Enter sempre quebra linha", () => {
	assert.equal(composerEnterAction({ ...base, touch: true }), "newline");
	assert.equal(composerEnterAction({ ...base, touch: true, shift: true }), "newline");
	assert.equal(composerEnterAction({ ...base, touch: true, mentionOpen: true }), "newline");
});

test("composição de IME nunca envia", () => {
	assert.equal(composerEnterAction({ ...base, touch: false, composing: true }), "newline");
});
