import { describe, expect, it } from "vitest";
import { pruneMcpArgs } from "./prune-args.js";

const listProducts = {
	type: "object",
	properties: {
		explanation: { type: "string" },
		nome: { type: "string" },
		idLoja: { type: "number" },
		idCategoria: { type: "number" },
		idsProdutos: { type: "array", items: { type: "number" } },
		filtroSaldoEstoque: { type: "string", enum: ["0", "1"] },
		criterio: { type: "string" },
		ativo: { type: "boolean" },
		pagina: { type: "number", default: 0 },
		body: {
			type: "object",
			properties: { nome: { type: "string" }, idDeposito: { type: "number" } },
			required: ["nome"],
		},
	},
	required: ["explanation"],
};

describe("pruneMcpArgs", () => {
	it("remove neutros do listProducts e mantém enum, boolean e obrigatório", () => {
		const { args, pruned } = pruneMcpArgs(
			{ explanation: "x", nome: "", idLoja: 0, idCategoria: "0", idsProdutos: [], filtroSaldoEstoque: "0", criterio: "2", ativo: false, pagina: 0 },
			listProducts,
		);
		expect(args).toEqual({ explanation: "x", filtroSaldoEstoque: "0", criterio: "2", ativo: false, pagina: 0 });
		expect(pruned).toEqual(["nome", "idLoja", "idCategoria", "idsProdutos"]);
	});

	it("nunca poda obrigatório, mesmo vazio", () => {
		expect(pruneMcpArgs({ explanation: "" }, listProducts).args).toEqual({ explanation: "" });
	});

	it("recursa em objetos e descarta objeto que ficou vazio", () => {
		const r = pruneMcpArgs({ explanation: "x", body: { nome: "", idDeposito: 0 } }, listProducts);
		expect(r.args).toEqual({ explanation: "x", body: { nome: "" } });
		expect(r.pruned).toEqual(["body.idDeposito"]);
		const r2 = pruneMcpArgs({ explanation: "x", body: {} }, listProducts);
		expect(r2.args).toEqual({ explanation: "x" });
	});

	it("mantém id real e schema ausente", () => {
		expect(pruneMcpArgs({ explanation: "x", idLoja: 5 }, listProducts).args).toEqual({ explanation: "x", idLoja: 5 });
		const raw = { a: 0, b: "" };
		expect(pruneMcpArgs(raw, undefined).args).toBe(raw);
	});
});
