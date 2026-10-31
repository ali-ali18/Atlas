import { describe, expect, it } from "vitest";
import { classifyMcpTool } from "./autonomy-tools.js";
import {
	toolMarkRefusal,
	hasServerToolAnnotation,
	looksLikeToolMarkRequest,
	mergeToolMarks,
	parseToolMarks,
	pendingToolMarkSuggestions,
	suggestToolMark,
	toolDisplayLabel,
} from "./tool-marks.js";

const tool = (name: string, description = "", annotations?: Record<string, boolean>) => ({ name, description, inputSchema: { type: "object" }, annotations });

describe("sugestão de marcação", () => {
	it("verbos de leitura no nome (en/pt) sugerem leitura", () => {
		for (const name of ["list_orders", "get_invoice", "search_items", "listar_pedidos", "buscar_cliente", "consultar_estoque", "ver_saldo"]) {
			expect(suggestToolMark(tool(name))).toBe("read");
		}
	});
	it("verbos de escrita no nome sugerem escrita, mesmo com descrição de leitura", () => {
		for (const name of ["create_order", "update_stock", "delete_item", "send_email", "criar_pedido", "alterar_preco", "excluir_nota", "enviar_nfe", "emitir_nota", "gerar_boleto"]) {
			expect(suggestToolMark(tool(name, "consulta somente leitura"))).toBe("write");
		}
	});
	it("sem verbo no nome a descrição decide; na dúvida, escreve", () => {
		expect(suggestToolMark(tool("avisos_ativos", "Consulta somente leitura dos avisos"))).toBe("read");
		expect(suggestToolMark(tool("avisos_ativos", "Cria avisos para o cliente"))).toBe("write");
		expect(suggestToolMark(tool("processar", "Faz o que precisa"))).toBe("write");
	});
});

describe("pendências e mescla", () => {
	const tools = [tool("listar_pedidos"), tool("criar_pedido"), tool("com_dica", "", { readOnlyHint: true }), tool("off")];
	it("só pendem as sem anotação do servidor, sem marcação confirmada e habilitadas", () => {
		expect(pendingToolMarkSuggestions(tools, { listar_pedidos: "read" }, ["off"])).toEqual({ criar_pedido: "write" });
	});
	it("mescla ignora tool desconhecida e a que o servidor anota", () => {
		expect(mergeToolMarks({ velha: "read" }, { listar_pedidos: "read", com_dica: "write", fantasma: "read" }, tools)).toEqual({ listar_pedidos: "read" });
		expect(hasServerToolAnnotation(tools[2]!)).toBe(true);
	});
	it("parse descarta lixo", () => {
		expect(parseToolMarks({ a: "read", b: "x", c: 3, "": "read" })).toEqual({ a: "read" });
		expect(parseToolMarks(["read"])).toEqual({});
		expect(parseToolMarks(null)).toEqual({});
	});
	it("rótulo sem nome interno", () => {
		expect(toolDisplayLabel({ name: "listar_pedidos" })).toBe("Listar pedidos");
		expect(toolDisplayLabel({ name: "x", title: " Pedidos " })).toBe("Pedidos");
	});
});

describe("precedência da classificação", () => {
	it("sem anotação: marcação 'read' vira leitura; 'write' ou ausente segue escrita", () => {
		expect(classifyMcpTool({ name: "listar_pedidos", ownerMark: "read" })).toBe("read");
		expect(classifyMcpTool({ name: "listar_pedidos", ownerMark: "write" })).toBe("write");
		expect(classifyMcpTool({ name: "listar_pedidos" })).toBe("write");
	});
	it("a anotação do servidor vence a marcação do dono", () => {
		expect(classifyMcpTool({ name: "listar_pedidos", annotations: { readOnlyHint: false }, ownerMark: "read" })).toBe("write");
		expect(classifyMcpTool({ name: "x", annotations: { destructiveHint: true }, ownerMark: "read" })).toBe("irreversible");
		expect(classifyMcpTool({ name: "x", annotations: { readOnlyHint: true }, ownerMark: "write" })).toBe("read");
	});
	it("verbo irreversível no nome nunca vira leitura por marcação", () => {
		expect(classifyMcpTool({ name: "delete_pedido", ownerMark: "read" })).toBe("irreversible");
	});
});

describe("verbo irreversível (en/pt/es) nunca vira leitura", () => {
	const names = ["enviar_nfe", "excluir_pedido", "apagar_cliente", "deletar_item", "remover_produto", "emitir_nota", "cancelar_pedido", "transmitir_nfe", "pagar_boleto", "transferir_estoque", "eliminar_registro", "borrar_cliente", "send_report", "delete_order"];
	it("a classificação ignora a marcação 'read' e a sugestão é escrita", () => {
		for (const name of names) {
			expect(classifyMcpTool({ name, ownerMark: "read" }), name).not.toBe("read");
			expect(suggestToolMark(tool(name, "consulta somente leitura")), name).toBe("write");
			expect(toolMarkRefusal(tool(name)), name).toMatch(/não dá para desfazer/);
		}
	});
	it("a mescla descarta 'read' dessas tools, mas aceita 'write'; leitura comum e aceita", () => {
		const tools = [tool("enviar_nfe"), tool("listar_pedidos")];
		expect(mergeToolMarks({}, { enviar_nfe: "read", listar_pedidos: "read" }, tools)).toEqual({ listar_pedidos: "read" });
		expect(mergeToolMarks({}, { enviar_nfe: "write" }, tools)).toEqual({ enviar_nfe: "write" });
		expect(toolMarkRefusal(tool("listar_pedidos"))).toBeNull();
		expect(toolMarkRefusal(tool("x", "", { readOnlyHint: true }))).toMatch(/conector já informa/);
	});
	it("nomes de consulta com palavras parecidas não são barrados", () => {
		for (const name of ["listar_notas_emitidas", "consultar_pagamentos", "listar_cancelamentos", "buscar_envios"]) expect(toolMarkRefusal(tool(name)), name).toBeNull();
	});
});

describe("pedido de marcação pelo chat", () => {
	it("reconhece o pedido do dono e ignora conversa comum", () => {
		expect(looksLikeToolMarkRequest("marca as consultas do Agroervas como somente leitura")).toBe(true);
		expect(looksLikeToolMarkRequest("pode confirmar as sugestões do conector")).toBe(true);
		expect(looksLikeToolMarkRequest("bom dia")).toBe(false);
		expect(looksLikeToolMarkRequest("lista os pedidos")).toBe(false);
	});
});
