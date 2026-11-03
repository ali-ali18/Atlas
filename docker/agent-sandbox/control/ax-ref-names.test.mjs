import test from "node:test";
import assert from "node:assert/strict";
import { isTreeRef, toAriaRef, toTreeRef } from "./ax-ref-names.mjs";

test("ida e volta: aria-ref do Playwright <-> ref da árvore, com prefixo de frame", () => {
	assert.equal(toTreeRef("e12"), "a12");
	assert.equal(toTreeRef("f1e12"), "f1a12");
	assert.equal(toAriaRef("a12"), "e12");
	assert.equal(toAriaRef("f1a12"), "f1e12");
});

test("o formato diz o motor: aN é da árvore, eN é do DOM, e um nunca vira o outro por engano", () => {
	assert.equal(isTreeRef("a12"), true);
	assert.equal(isTreeRef("f2a3"), true);
	assert.equal(isTreeRef("e12"), false);
	assert.equal(toAriaRef("e12"), "e12");
	assert.equal(toTreeRef("a12"), "a12");
	assert.equal(toTreeRef(""), "");
});
