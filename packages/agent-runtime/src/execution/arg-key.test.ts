import { describe, expect, it } from "vitest";
import { createConnectorReadCache } from "../mcp/read-cache.js";
import { nonSemanticParamNames, semanticArgs, semanticReadKey } from "./arg-key.js";

const schema = {
	type: "object",
	properties: {
		explanation: { type: "string" },
		why: { type: "string", description: "One sentence explaining why this call is made, for logging." },
		query: { type: "string", description: "Search text" },
		note_to_self: { type: "string", description: "Short explanation of your reasoning" },
		comment: { type: "string", enum: ["a", "b"] },
		limit: { type: "number" },
		page: { type: "integer" },
	},
};

describe("nonSemanticParamNames", () => {
	it("pega nomes de texto livre e descrições de explicação/log", () => {
		expect([...nonSemanticParamNames(schema)].sort()).toEqual(["explanation", "note_to_self", "why"]);
	});
	it("nunca ignora parâmetros que alteram o resultado (enum, número, busca)", () => {
		const names = nonSemanticParamNames(schema);
		for (const keep of ["query", "comment", "limit", "page"]) expect(names.has(keep)).toBe(false);
	});
	it("schema ausente ou estranho não ignora nada", () => {
		for (const raw of [undefined, null, "x", {}, { properties: [] }]) {
			expect(nonSemanticParamNames(raw).size).toBe(0);
		}
	});
});

describe("semanticReadKey", () => {
	it("a explicação variável e a ordem das chaves não mudam a chave", () => {
		const a = semanticReadKey("t", { explanation: "first look", limit: 10, query: "x" }, schema);
		const b = semanticReadKey("t", { query: "x", limit: 10, explanation: "again, other words" }, schema);
		expect(a).toBe(b);
	});
	it("params semânticos diferentes geram chaves diferentes", () => {
		const base = { explanation: "e", query: "x", limit: 10 };
		const key = semanticReadKey("t", base, schema);
		expect(semanticReadKey("t", { ...base, query: "y" }, schema)).not.toBe(key);
		expect(semanticReadKey("t", { ...base, limit: 20 }, schema)).not.toBe(key);
		expect(semanticReadKey("t", { ...base, page: 2 }, schema)).not.toBe(key);
		expect(semanticReadKey("other", base, schema)).not.toBe(key);
	});
	it("sem schema a chave considera todos os args", () => {
		expect(semanticArgs({ explanation: "e" }, undefined)).toEqual({ explanation: "e" });
	});
});

describe("cache de leitura do conector com keyArgs", () => {
	it("a segunda chamada com outra explicação é cache hit", async () => {
		const cache = createConnectorReadCache();
		let calls = 0;
		const run = (explanation: string) =>
			cache.run(
				{
					connector: "c",
					tool: "list_items",
					args: { explanation, query: "x" },
					keyArgs: semanticArgs({ explanation, query: "x" }, schema),
					readOnly: true,
				},
				async () => ({ ok: true, text: String(++calls), truncated: false }),
			);
		expect((await run("one")).text).toBe("1");
		expect((await run("two")).text).toBe("1");
		expect(calls).toBe(1);
	});
});
