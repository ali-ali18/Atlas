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

	describe("coercoes que o servidor costuma aceitar", () => {
		const one = (type: string, value: unknown) => validateMcpArgs({ type: "object", properties: { v: { type } } }, { v: value });
		it("numero e inteiro aceitam string numerica finita", () => {
			expect(one("number", "10")).toEqual([]);
			expect(one("number", "10.5")).toEqual([]);
			expect(one("number", "1e3")).toEqual([]);
			expect(one("integer", "10")).toEqual([]);
			expect(one("integer", "10.5")).toHaveLength(1);
			expect(one("integer", 10.5)).toHaveLength(1);
			expect(one("number", "1e999")).toHaveLength(1);
			expect(one("number", "abc")).toHaveLength(1);
		});
		it("booleano aceita 'true'/'false' e string aceita numero", () => {
			expect(one("boolean", "true")).toEqual([]);
			expect(one("boolean", "false")).toEqual([]);
			expect(one("boolean", "sim")).toHaveLength(1);
			expect(one("string", 42)).toEqual([]);
		});
		it("estrutura continua bloqueada", () => {
			expect(one("object", "x")).toHaveLength(1);
			expect(one("array", "x")).toHaveLength(1);
			expect(one("string", { a: 1 })).toHaveLength(1);
			expect(one("number", [1])).toHaveLength(1);
			expect(one("number", true)).toHaveLength(1);
		});
		it("string vazia em obrigatorio so passa se o schema permite explicitamente", () => {
			const req = (prop: object) => validateMcpArgs({ type: "object", required: ["v"], properties: { v: prop } }, { v: "" });
			expect(req({ type: "string" })).toHaveLength(1);
			expect(req({ type: "string", minLength: 0 })).toEqual([]);
			expect(req({ type: "string", enum: ["", "a"] })).toEqual([]);
			expect(req({ type: "string", enum: ["a"] })).toHaveLength(1);
			expect(validateMcpArgs({ type: "object", required: ["v"], properties: { v: { type: "string", minLength: 0 } } }, { v: null })).toHaveLength(1);
		});
	});

	it("mensagem lista campos e orientação", () => {
		const text = mcpArgsErrorMessage("criar_proposta", validateMcpArgs(schema, {}))!;
		expect(text).toContain("- cliente:");
		expect(text).toContain("- itens:");
		expect(text).toContain("não peça confirmação");
		expect(mcpArgsErrorMessage("x", [])).toBeNull();
	});
});
