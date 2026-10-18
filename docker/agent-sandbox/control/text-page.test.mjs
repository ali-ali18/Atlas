import { test } from "node:test";
import assert from "node:assert/strict";
import { clampPage, normalizeText, paginateText, TEXT_DEFAULT_LIMIT, TEXT_MAX_LIMIT } from "./text-page.mjs";

test("clampPage: padrões, teto e entradas inválidas", () => {
	assert.deepEqual(clampPage(), { offset: 0, limit: TEXT_DEFAULT_LIMIT });
	assert.deepEqual(clampPage({ offset: -5, limit: 99999 }), { offset: 0, limit: TEXT_MAX_LIMIT });
	assert.deepEqual(clampPage({ offset: "12", limit: "abc" }), { offset: 12, limit: TEXT_DEFAULT_LIMIT });
	assert.deepEqual(clampPage({ offset: 3.7, limit: 10.2 }), { offset: 3, limit: 10 });
});

test("paginateText: páginas consecutivas cobrem o texto e sinalizam o fim", () => {
	const text = "abcdefghij".repeat(10); // 100 chars
	const p1 = paginateText(text, { offset: 0, limit: 40 });
	assert.equal(p1.text.length, 40);
	assert.equal(p1.truncated, true);
	assert.equal(p1.nextOffset, 40);
	const p2 = paginateText(text, { offset: p1.nextOffset, limit: 40 });
	const p3 = paginateText(text, { offset: p2.nextOffset, limit: 40 });
	assert.equal(p3.text.length, 20);
	assert.equal(p3.truncated, false);
	assert.equal(p3.nextOffset, null);
	assert.equal(p1.text + p2.text + p3.text, text);
	assert.equal(p1.totalLength, 100);
});

test("paginateText: offset além do fim devolve vazio sem truncar", () => {
	const page = paginateText("abc", { offset: 50, limit: 10 });
	assert.equal(page.text, "");
	assert.equal(page.truncated, false);
});

test("normalizeText: colapsa linhas em branco", () => {
	assert.equal(normalizeText("a  \n\n\n\nb \n"), "a\n\nb");
});
