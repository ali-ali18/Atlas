import { test } from "node:test";
import assert from "node:assert/strict";
import { ITEM_DEFAULT_CHARS, PART_MAX_CHARS, parseReadArgs, planPart } from "./browser-chunks.mjs";

const entries = (n, size) => Array.from({ length: n }, (_, i) => ({ text: `${i}`.padEnd(size, "x"), chars: size }));

test("a parte diz onde termina e de onde seguir", () => {
	const part = planPart(entries(25, 100), { from: 1, loaded: 40, itemChars: 1500 });
	assert.equal(part.to, 25);
	assert.equal(part.nextFrom, 26);
	assert.equal(part.items[0].n, 1);
	const last = planPart(entries(15, 100), { from: 26, loaded: 40, itemChars: 1500 });
	assert.equal(last.to, 40);
	assert.equal(last.nextFrom, null);
});

test("a janela enche e a parte termina antes, sem perder item", () => {
	const part = planPart(entries(60, 2000), { from: 1, loaded: 60, itemChars: 2500 });
	assert.ok(part.items.length < 60);
	assert.ok(part.items.reduce((n, i) => n + i.text.length, 0) <= PART_MAX_CHARS);
	assert.equal(part.nextFrom, part.to + 1);
});

test("item maior que itemChars diz quantos caracteres ficaram de fora; item enorme sozinho ainda sai", () => {
	const part = planPart([{ text: "a".repeat(1000), chars: 3000 }], { from: 5, loaded: 5, itemChars: 1000 });
	assert.equal(part.items[0].clippedChars, 2000);
	assert.equal(part.items[0].n, 5);
	const alone = planPart([{ text: "a".repeat(30_000), chars: 30_000 }], { from: 1, loaded: 1, itemChars: 30_000, maxChars: 24_000 });
	assert.equal(alone.items.length, 1, "ao menos um item sempre sai");
});

test("seção vazia: nada, sem próximo", () => {
	assert.deepEqual(planPart([], { from: 1, loaded: 0, itemChars: 1500 }), { items: [], to: 0, nextFrom: null });
});

test("argumentos: padrões, limites e ids inválidos", () => {
	assert.deepEqual(parseReadArgs({ section: "s2" }), { section: "s2", exportId: undefined, from: 1, count: 50, itemChars: ITEM_DEFAULT_CHARS });
	assert.throws(() => parseReadArgs({}), /section/);
	assert.throws(() => parseReadArgs({ section: "../etc" }), /Invalid section/);
	assert.throws(() => parseReadArgs({ export: "x/../../y" }), /Invalid export/);
	assert.throws(() => parseReadArgs({ section: "s1", count: 201 }), /count/);
	assert.throws(() => parseReadArgs({ section: "s1", from: 0 }), /from/);
});
