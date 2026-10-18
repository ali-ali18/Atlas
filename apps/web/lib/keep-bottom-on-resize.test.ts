import assert from "node:assert/strict";
import test from "node:test";
import { shouldKeepBottomOnResize } from "./keep-bottom-on-resize";

test("teclado abriu (área encolheu) no fim da conversa: mantém o fim", () => {
	assert.equal(shouldKeepBottomOnResize({ previousHeight: 700, nextHeight: 380, wasStuck: true }), true);
});

test("teclado fechou (área cresceu) no fim da conversa: mantém o fim", () => {
	assert.equal(shouldKeepBottomOnResize({ previousHeight: 380, nextHeight: 700, wasStuck: true }), true);
});

test("lendo mensagens antigas: não mexe na rolagem", () => {
	assert.equal(shouldKeepBottomOnResize({ previousHeight: 700, nextHeight: 380, wasStuck: false }), false);
});

test("sem mudança de altura ou medida inválida: não faz nada", () => {
	assert.equal(shouldKeepBottomOnResize({ previousHeight: 700, nextHeight: 700, wasStuck: true }), false);
	assert.equal(shouldKeepBottomOnResize({ previousHeight: 0, nextHeight: 700, wasStuck: true }), false);
});
