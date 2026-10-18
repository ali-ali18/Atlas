import { describe, expect, it } from "vitest";
import { emptyResultHint, optionalFilterKeys } from "./empty-hint.js";

const listProducts = { type: "object", properties: { explanation: { type: "string" }, nome: { type: "string" } }, required: ["explanation"] };

describe("emptyResultHint", () => {
	const filters = optionalFilterKeys({ explanation: "x", nome: "alfazema" }, listProducts);
	it("detecta formatos vazios comuns", () => {
		for (const text of ['{"data":[]}', '{"items":[]}', '{"results":[]}', "[]", '{"totalRegistros":0,"x":1}']) {
			expect(emptyResultHint(text, filters)).toContain("{nome}");
		}
	});
	it("usa texto neutro", () => {
		const hint = emptyResultHint('{"data":[]}', filters) ?? "";
		expect(hint).toContain("partial keyword");
		expect(hint).not.toContain("stock");
	});
	it("ignora resultado com dados, sem filtros ou não JSON", () => {
		expect(emptyResultHint('{"data":[{"id":1}]}', filters)).toBeNull();
		expect(emptyResultHint('{"data":[]}', [])).toBeNull();
		expect(emptyResultHint("nada", filters)).toBeNull();
	});
});
