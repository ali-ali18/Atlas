import assert from "node:assert/strict";
import test from "node:test";
import { COMPOSER_FIELD_CLASS, shouldStickToEnd } from "./composer-scroll";

const base = { focused: true, selectionStart: 10, selectionEnd: 10, valueLength: 10 };

test("shouldStickToEnd: só com foco e cursor colapsado no fim", () => {
	assert.equal(shouldStickToEnd(base), true);
	assert.equal(shouldStickToEnd({ ...base, focused: false }), false);
	assert.equal(shouldStickToEnd({ ...base, selectionStart: 4, selectionEnd: 4 }), false, "cursor no meio");
	assert.equal(shouldStickToEnd({ ...base, selectionStart: 0, selectionEnd: 10 }), false, "seleção ampla");
	assert.equal(shouldStickToEnd({ ...base, selectionStart: null, selectionEnd: null }), false);
});

test("shouldStickToEnd: campo vazio não rola", () => {
	assert.equal(shouldStickToEnd({ focused: true, selectionStart: 0, selectionEnd: 0, valueLength: 0 }), false);
});

test("wrapper do campo: teto de altura, rola e contém o gesto", () => {
	for (const cls of ["max-h-32", "overflow-y-auto", "overscroll-contain", "touch-pan-y"])
		assert.ok(COMPOSER_FIELD_CLASS.split(" ").includes(cls), cls);
});
