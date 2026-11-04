import { describe, expect, it } from "vitest";
import { addEntry, type DiagEntry, entriesToText, formatLine, MAX_LINES } from "./apps-diagnostics";

describe("formatLine", () => {
	it("horário relativo, etapa e números", () => {
		expect(formatLine(1234.6, "toolkits:resposta", { chars: 90210, itens: 20 })).toBe("+1235ms toolkits:resposta chars=90210 itens=20");
	});
	it("sem números e com tempo negativo", () => {
		expect(formatLine(-5, "tela aberta")).toBe("+0ms tela aberta");
	});
	it("corta texto longo (o registro nunca guarda texto grande)", () => {
		expect(formatLine(0, "x", { erro: "a".repeat(100) })).toBe(`+0ms x erro=${"a".repeat(40)}…`);
	});
});

describe("addEntry", () => {
	it("acrescenta sem mudar o array recebido", () => {
		const base: DiagEntry[] = [{ text: "a" }];
		const next = addEntry(base, { text: "b" });
		expect(next.map((e) => e.text)).toEqual(["a", "b"]);
		expect(base).toHaveLength(1);
	});
	it("respeita o teto e descarta as mais antigas", () => {
		let list: DiagEntry[] = [];
		for (let i = 0; i < MAX_LINES + 15; i++) list = addEntry(list, { text: `l${i}` });
		expect(list).toHaveLength(MAX_LINES);
		expect(list[0]!.text).toBe("l15");
		expect(list.at(-1)!.text).toBe(`l${MAX_LINES + 14}`);
	});
	it("mesma chave substitui no lugar (render em cascata não cresce o registro)", () => {
		let list = addEntry([], { text: "inicio" });
		list = addEntry(list, { key: "render", text: "render n=1" });
		list = addEntry(list, { text: "meio" });
		for (let n = 2; n <= 500; n++) list = addEntry(list, { key: "render", text: `render n=${n}` });
		expect(entriesToText(list)).toBe("inicio\nrender n=500\nmeio");
	});
});
