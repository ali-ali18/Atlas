import { describe, expect, it } from "vitest";
import { mcpArgsErrorMessage, validateMcpArgs } from "./args-validation.js";

const schema = {
	type: "object",
	required: ["cliente", "itens"],
	properties: {
		cliente: { type: "object", required: ["id"], properties: { id: { type: "integer" }, nome: { type: "string" } } },
		situacao: { type: "string", enum: ["aberta", "fechada"] },
		itens: { type: "array", items: { type: "object", required: ["produto"], properties: { produto: { type: "string" } } } },
	},
};

describe("validateMcpArgs", () => {
	it("aceita argumentos completos", () => {
		expect(validateMcpArgs(schema, { cliente: { id: 1 }, situacao: "aberta", itens: [{ produto: "A" }] })).toEqual([]);
	});

	it("aponta obrigatório ausente, nulo, vazio e só espaços", () => {
		const paths = (args: Record<string, unknown>) => validateMcpArgs(schema, args).map((i) => i.path);
		expect(paths({ cliente: { id: 1 } })).toEqual(["itens"]);
		expect(paths({ cliente: { id: 1 }, itens: null })).toEqual(["itens"]);
		expect(paths({ itens: [{ produto: "A" }], cliente: "" })).toEqual(["cliente"]);
		expect(validateMcpArgs({ type: "object", required: ["a"], properties: { a: { type: "string" } } }, { a: "   " })[0]).toMatchObject({ path: "a", problem: "missing" });
	});

	it("aponta enum inválido e tipo errado", () => {
		const issues = validateMcpArgs(schema, { cliente: { id: "x" }, situacao: "xx", itens: [{ produto: "A" }] });
		expect(issues).toEqual([
			{ path: "cliente.id", problem: "type", expected: "integer" },
			{ path: "situacao", problem: "enum", expected: 'um de: "aberta", "fechada"' },
		]);
	});

	it("checa obrigatórios aninhados em objetos e itens de lista", () => {
		const issues = validateMcpArgs(schema, { cliente: { nome: "Ana" }, itens: [{ produto: "A" }, { produto: "" }] });
		expect(issues.map((i) => i.path)).toEqual(["cliente.id", "itens[1].produto"]);
	});

	it("sem schema, ou com schema não objeto, não bloqueia", () => {
		expect(validateMcpArgs(undefined, {})).toEqual([]);
		expect(validateMcpArgs("x", {})).toEqual([]);
		expect(validateMcpArgs({ oneOf: [{ required: ["a"] }] }, {})).toEqual([]);
	});

	it("opcional nulo ou vazio é ignorado", () => {
		expect(validateMcpArgs(schema, { cliente: { id: 1 }, itens: [{ produto: "A" }], situacao: "" })).toEqual([]);
	});

	it("mensagem lista campos e orientação", () => {
		const text = mcpArgsErrorMessage("criar_proposta", validateMcpArgs(schema, {}))!;
		expect(text).toContain("- cliente:");
		expect(text).toContain("- itens:");
		expect(text).toContain("não peça confirmação");
		expect(mcpArgsErrorMessage("x", [])).toBeNull();
	});
});
