import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { classifyMcpTool, hasIrreversibleToolName } from "./autonomy-tools.js";
import {
	toolMarkRefusal,
	hasServerToolAnnotation,
	looksLikeToolMarkRequest,
	mergeToolMarks,
	parseToolMarks,
	pendingToolMarkSuggestions,
	buildStoredToolMarks,
	parseStoredToolMarks,
	resolveToolMarks,
	toolDefinitionHash,
	suggestToolMark,
	toolDisplayLabel,
} from "./tool-marks.js";

const stable = (v: unknown): string => Array.isArray(v) ? `[${v.map(stable).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v) ?? "null";
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
	it("a descrição nunca promove a leitura: nome sem verbo de leitura escreve; descrição só rebaixa", () => {
		expect(suggestToolMark(tool("avisos_ativos", "Consulta somente leitura dos avisos"))).toBe("write");
		expect(suggestToolMark(tool("processar", "Returns status"))).toBe("write");
		expect(suggestToolMark(tool("orderStatusChange", "Returns status"))).toBe("write");
		expect(suggestToolMark(tool("listar_avisos", "Lista avisos e permite atualizar o contador"))).toBe("write");
		expect(suggestToolMark(tool("listar_avisos", "Returns status"))).toBe("read");
	});
	it("bateria: ações com efeito (fiscal, financeiro, externo) nunca são sugeridas como leitura", () => {
		const names = [
			"authorizeNfe", "autorizarNfe", "submitOrder", "dispatchOrder", "refundPayment", "estornarPagamento", "baixarConta", "faturarPedido",
			"chargeCard", "cobrar", "orderStatusChange", "excluír_pedido", "ｅnviar_nfe", "approve_invoice", "aprovar_pedido", "sign_document", "assinar_contrato",
			"void_invoice", "capture_payment", "settle_account", "transmit_nfe", "revoke_token", "reembolsar_cliente",
		];
		for (const name of names) {
			expect(suggestToolMark(tool(name, "Returns status")), name).toBe("write");
			expect(toolMarkRefusal(tool(name)) !== null || !hasIrreversibleToolName(name), name).toBe(true);
		}
		for (const name of ["authorizeNfe", "autorizarNfe", "submitOrder", "refundPayment", "baixarConta", "faturarPedido", "chargeCard", "excluír_pedido", "ｅnviar_nfe"]) {
			expect(toolMarkRefusal(tool(name)), name).toMatch(/não dá para desfazer/);
			expect(classifyMcpTool({ name, ownerMark: "read" }), name).toBe("irreversible");
		}
	});
	it("consultas com substantivos parecidos continuam aceitando leitura", () => {
		for (const name of ["listRefunds", "get_signature", "list_charges", "listar_autorizacoes", "get_signal"]) {
			expect(hasIrreversibleToolName(name), name).toBe(false);
		}
	});
});

describe("bateria: ação com efeito não aceita marcação de leitura (lista negra + allowlist)", () => {
	const effects = [
		"emitNfe", "nfeEmit", "emissaoNfe", "cancelNFe", "cancelOrder", "processPayment", "executeOrder", "runJob", "trigger_webhook", "fireWebhook",
		"invokeFunction", "reverseTransaction", "withdraw", "payout", "debit_account", "issueInvoice", "confirmOrder", "bookShipment", "notifyCustomer",
		"lancarNota", "generateSalesOrderNfe", "manageSalesOrderStock", "updateSalesOrderStatus", "markAsPaid", "setStatus",
	];
	it("toda ação com efeito é recusada como leitura, com motivo claro, e a mescla descarta", () => {
		for (const name of effects) {
			expect(toolMarkRefusal(tool(name)), name).toMatch(/não dá para desfazer|não indica só leitura/);
			expect(mergeToolMarks({}, { [name]: "read" }, [tool(name)]), name).toEqual({});
			expect(suggestToolMark(tool(name, "Returns status")), name).toBe("write");
		}
	});
	it("verbo de execução/disparo/dinheiro é irreversível (nunca vira leitura nem por marcação do dono)", () => {
		for (const name of ["emitNfe", "nfeEmit", "emissaoNfe", "cancelNFe", "cancelOrder", "processPayment", "executeOrder", "runJob", "trigger_webhook", "fireWebhook", "invokeFunction", "reverseTransaction", "withdraw", "payout", "debit_account", "issueInvoice", "lancarNota"]) {
			expect(hasIrreversibleToolName(name), name).toBe(true);
			expect(classifyMcpTool({ name, ownerMark: "read" }), name).toBe("irreversible");
		}
	});
	it("'issue' é verbo só no começo do nome e com objeto fiscal (issueInvoice); issue do GitHub não é irreversível", () => {
		expect(hasIrreversibleToolName("issue_refund")).toBe(true);
		for (const name of ["create_issue", "get_issue", "list_issues", "issue_write", "issue_read"]) expect(hasIrreversibleToolName(name), name).toBe(false);
	});
	it("sem verbo de leitura no nome: o nome sozinho não promove a leitura (mensagem clara)", () => {
		for (const name of ["setStatus", "markAsPaid", "manageSalesOrderStock", "updateSalesOrderStatus", "generateSalesOrderNfe", "avisos_ativos"]) {
			expect(toolMarkRefusal(tool(name)), name).toBe("o nome desta ferramenta não indica só leitura, então ela continua pedindo aprovação");
		}
	});
	it("verbo de leitura MAIS verbo de escrita no nome também é recusado", () => {
		for (const name of ["get_and_update_order", "listar_e_cancelar", "fetchAndDelete", "buscar_e_atualizar"]) expect(toolMarkRefusal(tool(name)), name).not.toBeNull();
	});
	it("consultas legítimas continuam aceitando leitura", () => {
		const reads = [
			"listRefunds", "getSignature", "listar_autorizacoes", "get_invoice", "buscar_pedidos", "listNfes", "getNfe", "list_charges", "consultar_estornos",
			"list_approvals", "getApprovalStatus", "searchCharges", "listSubmissions", "getVoidedOrders", "listSigners", "get_payment_status",
		];
		for (const name of reads) {
			expect(hasIrreversibleToolName(name), name).toBe(false);
			expect(toolMarkRefusal(tool(name)), name).toBeNull();
			expect(suggestToolMark(tool(name)), name).toBe("read");
		}
	});
	it("marcar como escrita continua permitido para qualquer nome", () => {
		expect(toolMarkRefusal(tool("emitNfe"), "write")).toBeNull();
		expect(toolMarkRefusal(tool("setStatus"), "write")).toBeNull();
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
		expect(looksLikeToolMarkRequest("Pode marcar as ferramentas de consulta como somente leitura?")).toBe(true);
		expect(looksLikeToolMarkRequest("Por favor, deixe só leitura as consultas do ERP")).toBe(true);
		expect(looksLikeToolMarkRequest("Mark the ERP tools as read-only")).toBe(true);
	});
	it("frase descritiva (sem pedido) não conta", () => {
		expect(looksLikeToolMarkRequest("O ERP está em modo somente leitura para as ferramentas de consulta")).toBe(false);
		expect(looksLikeToolMarkRequest("As ferramentas são somente leitura")).toBe(false);
		expect(looksLikeToolMarkRequest("A API do ERP é read-only tools only")).toBe(false);
	});
});

describe("marca amarrada à definição da tool (hash)", () => {
	const listar = { name: "listar_pedidos", description: "Lista pedidos", inputSchema: { type: "object", properties: { page: { type: "number" } } } };
	it("hash é estável (ordem das chaves) e muda com descrição ou schema", () => {
		const reordered = { ...listar, inputSchema: { properties: { page: { type: "number" } }, type: "object" } };
		expect(toolDefinitionHash(listar)).toBe(toolDefinitionHash(reordered));
		expect(toolDefinitionHash(listar)).toMatch(/^[0-9a-f]{16}$/);
		expect(toolDefinitionHash({ ...listar, description: "Lista e apaga pedidos" })).not.toBe(toolDefinitionHash(listar));
		expect(toolDefinitionHash({ ...listar, inputSchema: { type: "object", properties: { id: { type: "string" } } } })).not.toBe(toolDefinitionHash(listar));
	});
	it("a implementação de SHA-256 confere com node:crypto", () => {
		const cases = [{ inputSchema: {} }, { description: "x".repeat(200), inputSchema: { a: [1, 2, { b: null }] } }, { description: "ção ✓", inputSchema: { type: "object" } }];
		for (const c of cases) {
			const json = `{"d":${JSON.stringify(c.description ?? "")},"s":${stable(c.inputSchema)}}`;
			expect(toolDefinitionHash(c)).toBe(createHash("sha256").update(json).digest("hex").slice(0, 16));
		}
	});
	it("a marca vale com a definição confirmada; se o servidor muda, vira obsoleta e volta a pendente", () => {
		const stored = buildStoredToolMarks({ listar_pedidos: "read" }, {}, [listar]);
		expect(resolveToolMarks(stored, [listar])).toEqual({ marks: { listar_pedidos: "read" }, stale: [] });
		const changed = { ...listar, description: "Lista pedidos e também cancela" };
		expect(resolveToolMarks(stored, [changed])).toEqual({ marks: {}, stale: ["listar_pedidos"] });
		expect(pendingToolMarkSuggestions([changed], resolveToolMarks(stored, [changed]).marks)).toHaveProperty("listar_pedidos");
	});
	it("obsoleta que o dono não tocou continua guardada; reconfirmar grava o hash novo", () => {
		const stored = buildStoredToolMarks({ listar_pedidos: "read" }, {}, [listar]);
		const changed = { ...listar, description: "mudou" };
		expect(buildStoredToolMarks({}, stored, [changed])).toEqual(stored);
		const again = buildStoredToolMarks({ listar_pedidos: "read" }, stored, [changed]);
		expect(resolveToolMarks(again, [changed]).marks).toEqual({ listar_pedidos: "read" });
	});
	it("formato antigo (sem hash) pede confirmação de novo; lista vazia não apaga nem invalida", () => {
		const legacy = parseStoredToolMarks({ listar_pedidos: "read", x: { mark: "write", hash: "abc" }, y: { mark: "bad" } });
		expect(legacy).toEqual({ listar_pedidos: { mark: "read" }, x: { mark: "write", hash: "abc" } });
		expect(resolveToolMarks(legacy, [listar]).stale).toEqual(["listar_pedidos"]);
		expect(resolveToolMarks(legacy, [])).toEqual({ marks: {}, stale: [] });
		expect(mergeToolMarks({ listar_pedidos: "read" }, { listar_pedidos: "write" }, [])).toEqual({ listar_pedidos: "read" });
	});
});

describe("regressão: tools pt/es sem anotação passam de escrita a irreversível (CHANGELOG 0.3.3-beta)", () => {
	const names = ["excluir_pedido", "enviar_nfe", "cancelar_pedido", "emitir_nota", "pagar_boleto", "transmitir_nfe", "apagar_cliente", "eliminar_registro", "borrar_cliente", "autorizar_nfe", "estornar_pagamento", "faturar_pedido", "cobrar_cliente", "baixar_conta"];
	it("sem anotação: irreversível (sempre pede cartão, nunca 'Sempre para…', nunca leitura), e não mais 'write'", () => {
		for (const name of names) {
			expect(classifyMcpTool({ name }), name).toBe("irreversible");
			expect(classifyMcpTool({ name, ownerMark: "read" }), name).toBe("irreversible");
			expect(hasIrreversibleToolName(name), name).toBe(true);
		}
	});
	it("o contraste: nome neutro sem anotação continua escrita reversível", () => {
		for (const name of ["criar_pedido", "atualizar_estoque", "orderStatusChange"]) expect(classifyMcpTool({ name }), name).toBe("write");
	});
});
