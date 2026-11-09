import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMap, parseDeclaredCount } from "./browser-map.mjs";

test("total declarado: milhar, sufixo, vírgula e ano", () => {
	assert.equal(parseDeclaredCount("1,024 Comments"), 1024);
	assert.equal(parseDeclaredCount("1.024 comentários"), 1024);
	assert.equal(parseDeclaredCount("(1 024)"), 1024);
	assert.equal(parseDeclaredCount("1,2 mil comentários"), 1200);
	assert.equal(parseDeclaredCount("2.3M views"), 2_300_000);
	assert.equal(parseDeclaredCount("48 reviews"), 48);
	assert.equal(parseDeclaredCount("Reviews 2024"), null, "ano solto não é total");
	assert.equal(parseDeclaredCount("Comments"), null);
	assert.equal(parseDeclaredCount(""), null);
});

test("mapa: total vem das dicas, carregar mais vem do botão, da rolagem ou do total maior que o carregado", () => {
	const raw = {
		url: "https://x.test/",
		title: "T",
		totalChars: 5000,
		omitted: 0,
		sections: [
			{ id: "s1", kind: "text", label: "Page text", items: 12, countHints: [], moreControl: false, scrollable: false, chars: 900, preview: "intro" },
			{ id: "s2", kind: "list", label: "1,000 Comments", items: 40, countHints: ["1,000 Comments"], moreControl: false, scrollable: false, chars: 4000 },
			{ id: "s3", kind: "list", label: "Related", items: 5, countHints: [], moreControl: true, scrollable: false, chars: 300 },
			{ id: "s4", kind: "table", label: "Prices", items: 10, countHints: ["10"], moreControl: false, scrollable: false, chars: 300 },
		],
	};
	const map = buildMap(raw);
	const by = Object.fromEntries(map.sections.map((s) => [s.id, s]));
	assert.deepEqual([by.s2.declaredTotal, by.s2.canLoadMore], [1000, true]);
	assert.deepEqual([by.s3.declaredTotal, by.s3.canLoadMore], [null, true]);
	assert.deepEqual([by.s4.declaredTotal, by.s4.canLoadMore], [10, false], "tudo carregado: não oferece carregar mais");
	assert.deepEqual([by.s1.declaredTotal, by.s1.canLoadMore], [null, false], "texto não carrega mais");
});

test("mapa diz o que ficou de fora e o aviso de árvore pobre", () => {
	const map = buildMap({ url: "u", title: "t", totalChars: 1, omitted: 7, poorTree: true, wall: "captcha", sections: [] });
	assert.equal(map.omittedSections, 7);
	assert.equal(map.poorTree, true);
	assert.equal(map.wall, "captcha");
});
