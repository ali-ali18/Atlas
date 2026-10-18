import { describe, expect, it } from "vitest";
import { buildClipNotice, clipWithNotice, describeClippedItems } from "./clip-notice.js";

const records = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i, name: `item-${i}` }));

describe("describeClippedItems", () => {
	it("array na raiz: conta itens completos no prefixo", () => {
		const text = JSON.stringify(records(100));
		const out = describeClippedItems(text, 200);
		expect(out?.total).toBe(100);
		expect(out?.shown).toBeGreaterThan(0);
		expect(out?.shown).toBeLessThan(100);
	});

	it.each(["data", "items", "results"])("array em `%s`", (key) => {
		const text = JSON.stringify({ page: 1, [key]: records(50) });
		const out = describeClippedItems(text, 150);
		expect(out?.total).toBe(50);
		expect(out?.shown).toBeLessThan(50);
	});

	it("vírgulas dentro de strings não contam como itens", () => {
		const text = JSON.stringify([{ a: "x,y,z" }, { a: "q,w" }, { a: "e" }]);
		expect(describeClippedItems(text, text.indexOf('{"a":"e"')+3)).toEqual({ shown: 2, total: 3 });
	});

	it("texto fora de JSON, malformado ou sem array devolve null", () => {
		expect(describeClippedItems("apenas texto livre", 5)).toBeNull();
		expect(describeClippedItems('{"data": [1, 2,', 5)).toBeNull();
		expect(describeClippedItems('{"count": 3}', 5)).toBeNull();
		expect(describeClippedItems("", 0)).toBeNull();
	});
});

describe("clipWithNotice", () => {
	it("abaixo do limite não altera", () => {
		expect(clipWithNotice("curto", 10)).toEqual({ text: "curto", truncated: false });
	});

	it("acima do limite inclui aviso com caracteres e contagem de itens", () => {
		const text = JSON.stringify({ data: records(736) });
		const out = clipWithNotice(text, 2000);
		expect(out.truncated).toBe(true);
		expect(out.text).toContain("[Result truncated: showing ~2000 of " + text.length + " characters (");
		expect(out.text).toMatch(/\(\d+ of 736 items\)/);
		expect(out.text).toContain("Do not conclude about items not shown");
		expect(out.text).toContain("fetch further pages");
	});

	it("não-JSON: aviso sem contagem de itens", () => {
		const notice = buildClipNotice("x".repeat(50), 10);
		expect(notice).toContain("showing ~10 of 50 characters.");
		expect(notice).not.toContain("items)");
	});
});
