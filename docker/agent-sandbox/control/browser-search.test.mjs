import { test } from "node:test";
import assert from "node:assert/strict";
import { searchItems, snippetAround } from "./browser-search.mjs";

const items = ["Ótimo preço, comprei", "Frete caro demais", "O PRECO subiu e o frete também", "nada a ver"].map((text, i) => ({ n: i + 1, text }));

test("todas as palavras, sem acento nem caixa, com o total", () => {
	const r = searchItems(items, "preço frete");
	assert.equal(r.total, 1);
	assert.equal(r.matches[0].n, 3);
	assert.equal(searchItems(items, "PREÇO").total, 2);
});

test("limite corta os trechos, não o total", () => {
	const r = searchItems(items, "o", 1);
	assert.equal(r.matches.length, 1);
	assert.ok(r.total > 1);
});

test("busca vazia falha", () => {
	assert.throws(() => searchItems(items, "   "), /at least one word/);
});

test("trecho longo fica em volta da palavra, com reticências", () => {
	const text = `${"a ".repeat(300)}discount code ATLAS${" b".repeat(300)}`;
	const snip = snippetAround(text, ["discount"], 100);
	assert.ok(snip.includes("discount"));
	assert.ok(snip.startsWith("…") && snip.endsWith("…"));
	assert.ok(snip.length <= 102);
	assert.equal(snippetAround("curto", ["x"]), "curto");
});
