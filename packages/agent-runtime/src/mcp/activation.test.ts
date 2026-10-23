import { describe, expect, it } from "vitest";
import type { ChatTool } from "@workspace/llm";
import type { McpToolEntry } from "./registry.js";
import {
	connectorToolNames,
	findExactMcpToolMatches,
	findReferencedMcpTools,
	findSiblingReadTools,
	listMcpToolNames,
	planMcpActivation,
	searchMcpTools,
	summarizeMcpTools,
} from "./activation.js";

/**
 * Índice + carregar sob demanda: scoring e orçamento de ativação são lógica
 * pura (sem run/rede/banco) — testados aqui isolados de computer-use.ts.
 */

function tool(name: string, description: string, extraChars = 0): ChatTool {
	return {
		type: "function",
		function: {
			name,
			description: `${description}${"z".repeat(extraChars)}`,
			parameters: { type: "object", properties: {} },
		},
	};
}

function entry(connectionName: string, toolName: string, readOnly = true): McpToolEntry {
	return {
		connectionId: `conn-${connectionName}`,
		connectionName,
		toolName,
		readOnly,
		actionClass: readOnly ? "read" : "write",
		autonomyMeta: {
			actionClass: readOnly ? "read" : "write",
			tool: `mcp__${connectionName.toLowerCase()}__${toolName}`,
			connectors: [connectionName.toLowerCase()],
		},
		requiresConfirmation: !readOnly,
	};
}

function buildCatalog(
	items: Array<{ name: string; toolName: string; connectorName: string; description: string; readOnly?: boolean }>,
) {
	const available = new Map<string, ChatTool>();
	const entries = new Map<string, McpToolEntry>();
	for (const item of items) {
		available.set(item.name, tool(item.name, `[${item.connectorName}] ${item.description}`));
		entries.set(item.name, entry(item.connectorName, item.toolName, item.readOnly ?? true));
	}
	return { available, entries };
}

describe("findExactMcpToolMatches", () => {
	const { available, entries } = buildCatalog([
		{ name: "mcp__google_drive__search_files", toolName: "search_files", connectorName: "Google Drive", description: "Localiza arquivos" },
		{ name: "mcp__gmail__search_threads", toolName: "search_threads", connectorName: "Gmail", description: "Busca conversas" },
	]);

	it("acha por nome exposto ou original, case-insensitive, separado por espaço/vírgula", () => {
		expect(findExactMcpToolMatches("Search_Files", available, entries)).toEqual([
			"mcp__google_drive__search_files",
		]);
		// Ordem segue a iteração do catálogo (ordem de conexão), não a da query.
		expect(
			findExactMcpToolMatches("mcp__gmail__search_threads, search_files", available, entries),
		).toEqual(["mcp__google_drive__search_files", "mcp__gmail__search_threads"]);
	});

	it("sem termos ou sem match: lista vazia", () => {
		expect(findExactMcpToolMatches("   ", available, entries)).toEqual([]);
		expect(findExactMcpToolMatches("nada_aqui", available, entries)).toEqual([]);
	});

	it("unattended exclui tools que pedem confirmação mesmo com nome exato", () => {
		const writeCatalog = buildCatalog([
			{ name: "mcp__notion__create_page", toolName: "create_page", connectorName: "Notion", description: "Cria página", readOnly: false },
		]);
		expect(
			findExactMcpToolMatches("create_page", writeCatalog.available, writeCatalog.entries, {
				unattended: true,
			}),
		).toEqual([]);
	});
});

describe("searchMcpTools", () => {
	const { available, entries } = buildCatalog([
		{ name: "mcp__google_drive__search_files", toolName: "search_files", connectorName: "Google Drive", description: "Localiza arquivos por nome" },
		{ name: "mcp__google_drive__list_recent_files", toolName: "list_recent_files", connectorName: "Google Drive", description: "Lista arquivos recentes" },
		{ name: "mcp__gmail__search_threads", toolName: "search_threads", connectorName: "Gmail", description: "Busca conversas de e-mail" },
	]);

	it("pontua 3x nome + 2x conector + 1x descrição; ordena desc e corta no limit", () => {
		const results = searchMcpTools({ query: "arquivos drive", available, entries });
		expect(results.map((r) => r.name)).toEqual([
			"mcp__google_drive__search_files",
			"mcp__google_drive__list_recent_files",
		]);
		expect(results[0]!.score).toBeGreaterThan(0);
	});

	it("filtra por conector (nome ou slug), acento/caixa-insensitive", () => {
		const byName = searchMcpTools({ query: "arquivos", available, entries, connector: "Google Drive" });
		expect(byName.every((r) => r.connectorName === "Google Drive")).toBe(true);
		const bySlug = searchMcpTools({ query: "arquivos", available, entries, connector: "google_drive" });
		expect(bySlug.length).toBe(byName.length);
	});

	it("sem hits: lista vazia", () => {
		expect(searchMcpTools({ query: "xyzxyz123", available, entries })).toEqual([]);
	});

	it("respeita o limit (1-10)", () => {
		const results = searchMcpTools({ query: "arquivos files recentes", available, entries, limit: 1 });
		expect(results).toHaveLength(1);
	});
});

describe("planMcpActivation", () => {
	function bigTool(name: string): ChatTool {
		return tool(name, "descrição", 500);
	}
	const available = new Map<string, ChatTool>([
		["a", bigTool("a")],
		["b", bigTool("b")],
		["c", bigTool("c")],
		["d", bigTool("d")],
	]);

	it("ativa nomes novos e mantém os já ativos", () => {
		const plan = planMcpActivation({
			namesToActivate: ["b"],
			available,
			activeOrder: ["a"],
			maxTools: 10,
			maxJsonChars: 1_000_000,
		});
		expect(plan.activated).toEqual(["b"]);
		expect(plan.finalOrder).toEqual(["a", "b"]);
		expect(plan.evicted).toEqual([]);
	});

	it("evicta as mais antigas (LRU) quando estoura maxTools, nunca as recém-ativadas", () => {
		const plan = planMcpActivation({
			namesToActivate: ["c", "d"],
			available,
			activeOrder: ["a", "b"],
			maxTools: 3,
			maxJsonChars: 1_000_000,
		});
		expect(plan.activated).toEqual(["c", "d"]);
		expect(plan.evicted).toEqual(["a"]);
		expect(plan.finalOrder).toEqual(["b", "c", "d"]);
		expect(plan.finalOrder.length).toBeLessThanOrEqual(3);
	});

	it("evicta por teto de JSON mesmo com poucas tools", () => {
		const sizeOfOne = JSON.stringify(available.get("a")).length;
		const plan = planMcpActivation({
			namesToActivate: ["b"],
			available,
			activeOrder: ["a"],
			maxTools: 10,
			maxJsonChars: sizeOfOne + 10, // só cabe ~1 tool no JSON
		});
		expect(plan.activated).toEqual(["b"]);
		expect(plan.evicted).toEqual(["a"]);
		expect(plan.finalOrder).toEqual(["b"]);
	});

	it("nomes já ativos ou desconhecidos não reativam nem duplicam", () => {
		const plan = planMcpActivation({
			namesToActivate: ["a", "nao-existe"],
			available,
			activeOrder: ["a"],
			maxTools: 10,
			maxJsonChars: 1_000_000,
		});
		expect(plan.activated).toEqual([]);
		expect(plan.finalOrder).toEqual(["a"]);
	});

	it("pinned (F4): tool chamada no run nunca sai no LRU", () => {
		const plan = planMcpActivation({
			namesToActivate: ["c", "d"],
			available,
			activeOrder: ["a", "b"],
			maxTools: 3,
			maxJsonChars: 1_000_000,
			pinned: ["a"],
		});
		expect(plan.activated).toEqual(["c", "d"]);
		expect(plan.evicted).toEqual(["b"]);
		expect(plan.finalOrder).toEqual(["a", "c", "d"]);
	});
});

describe("summarizeMcpTools / listMcpToolNames", () => {
	const { available, entries } = buildCatalog([
		{ name: "mcp__google_drive__search_files", toolName: "search_files", connectorName: "Google Drive", description: "Localiza arquivos" },
		{ name: "mcp__gmail__search_threads", toolName: "search_threads", connectorName: "Gmail", description: "Busca conversas" },
	]);

	it("summarizeMcpTools: nome_exposto — resumo, uma por linha", () => {
		expect(
			summarizeMcpTools(["mcp__google_drive__search_files", "mcp__gmail__search_threads"], available, entries),
		).toBe(
			"mcp__google_drive__search_files — Localiza arquivos\nmcp__gmail__search_threads — Busca conversas",
		);
	});

	it("listMcpToolNames: agrupa por conector, filtra quando informado", () => {
		expect(listMcpToolNames(entries)).toBe(
			"- Google Drive: search_files\n- Gmail: search_threads",
		);
		expect(listMcpToolNames(entries, "gmail")).toBe("- Gmail: search_threads");
	});
});


describe("apps do Composio na busca por conector", () => {
	const catalog = buildCatalog([
		{ name: "mcp__composio__LINEAR_LIST_ISSUES", toolName: "LINEAR_LIST_ISSUES", connectorName: "Composio", description: "List issues" },
		{ name: "mcp__composio__NOTION_SEARCH", toolName: "NOTION_SEARCH", connectorName: "Composio", description: "Search pages and issues" },
		{ name: "mcp__notion__search", toolName: "search", connectorName: "Notion", description: "Search pages and issues" },
		{ name: "mcp__composio__GOOGLE_DRIVE_LIST_FILES", toolName: "GOOGLE_DRIVE_LIST_FILES", connectorName: "Composio", description: "List files" },
	]);
	for (const value of catalog.entries.values()) {
		if (value.connectionName === "Composio") value.autonomyMeta.connectors = ["composio"];
	}

	it("encontra Linear sem confundir as tools de outros apps", () => {
		expect(searchMcpTools({ ...catalog, query: "issues", connector: "linear" }).map((result) => result.name)).toEqual(["mcp__composio__LINEAR_LIST_ISSUES"]);
	});

	it("lista somente o app solicitado no resultado de busca vazia", () => {
		expect(listMcpToolNames(catalog.entries, "Linear")).toBe("- Composio: LINEAR_LIST_ISSUES");
	});

	it("mantém Notion nativo e Composio elegíveis e respeita aliases de Google Drive", () => {
		expect(searchMcpTools({ ...catalog, query: "search", connector: "notion" }).map((result) => result.name).sort()).toEqual(["mcp__composio__NOTION_SEARCH", "mcp__notion__search"].sort());
		for (const connector of ["Google Drive", "google_drive", "googledrive"]) {
			expect(searchMcpTools({ ...catalog, query: "files", connector }).map((result) => result.name)).toEqual(["mcp__composio__GOOGLE_DRIVE_LIST_FILES"]);
		}
	});

	it("não interpreta prefixos de tool de outros conectores como apps do Composio", () => {
		const unrelated = buildCatalog([{ name: "mcp__custom__LINEAR_LIST_ISSUES", toolName: "LINEAR_LIST_ISSUES", connectorName: "Custom", description: "List issues" }]);
		expect(searchMcpTools({ ...unrelated, query: "issues", connector: "linear" })).toEqual([]);
		expect(searchMcpTools({ ...catalog, query: "issues", connector: "lin" })).toEqual([]);
	});
});

describe("findReferencedMcpTools", () => {
	const items = [
		{ name: "mcp__n8n__create_workflow_from_code", toolName: "create_workflow_from_code", connectorName: "n8n", description: "Cria. Valide com validate_workflow e leia get_workflow_sdk_reference antes; não é search.", readOnly: false },
		{ name: "mcp__n8n__validate_workflow", toolName: "validate_workflow", connectorName: "n8n", description: "Valida" },
		{ name: "mcp__n8n__get_workflow_sdk_reference", toolName: "get_workflow_sdk_reference", connectorName: "n8n", description: "Referência do SDK" },
		{ name: "mcp__n8n__search", toolName: "search", connectorName: "n8n", description: "Busca" },
		{ name: "mcp__n8n__validate_workflow_extra", toolName: "validate_workflow_extra", connectorName: "n8n", description: "Outra" },
		{ name: "mcp__other__validate_workflow", toolName: "validate_workflow", connectorName: "Other", description: "Outro conector" },
	];
	const { available, entries } = buildCatalog(items);

	it("carrega junto as tools do mesmo conector citadas na descrição", () => {
		expect(
			findReferencedMcpTools({ names: ["mcp__n8n__create_workflow_from_code"], available, entries }),
		).toEqual(["mcp__n8n__validate_workflow", "mcp__n8n__get_workflow_sdk_reference"]);
	});

	it("não repete as já escolhidas, ignora nomes curtos e respeita o limite", () => {
		expect(
			findReferencedMcpTools({
				names: ["mcp__n8n__create_workflow_from_code", "mcp__n8n__validate_workflow"],
				available,
				entries,
			}),
		).toEqual(["mcp__n8n__get_workflow_sdk_reference"]);
		expect(
			findReferencedMcpTools({ names: ["mcp__n8n__create_workflow_from_code"], available, entries, limit: 1 }),
		).toEqual(["mcp__n8n__validate_workflow"]);
	});
});

describe("connectorToolNames (@App do usuário)", () => {
	const { available, entries } = buildCatalog([
		{ name: "mcp__gmail__send_email", toolName: "send_email", connectorName: "Gmail", description: "Envia", readOnly: false },
		{ name: "mcp__gmail__search_threads", toolName: "search_threads", connectorName: "Gmail", description: "Busca" },
		{ name: "mcp__drive__search_files", toolName: "search_files", connectorName: "Google Drive", description: "Localiza" },
	]);

	it("acha as tools do conector pelo nome (sem acento/caixa), leitura primeiro", () => {
		expect(connectorToolNames({ connectors: ["gmail"], available, entries })).toEqual(["mcp__gmail__search_threads", "mcp__gmail__send_email"]);
		expect(connectorToolNames({ connectors: ["Google Drive"], available, entries })).toEqual(["mcp__drive__search_files"]);
	});

	it("sem humano para confirmar, as de confirmação ficam fora; desconhecido e limite", () => {
		expect(connectorToolNames({ connectors: ["Gmail"], available, entries, unattended: true })).toEqual(["mcp__gmail__search_threads"]);
		expect(connectorToolNames({ connectors: ["Slack"], available, entries })).toEqual([]);
		expect(connectorToolNames({ connectors: ["Gmail"], available, entries, limit: 1 })).toHaveLength(1);
	});

	it("tool fora do que o runtime expõe (bloqueada pela autonomia) não entra", () => {
		const trimmed = new Map(available);
		trimmed.delete("mcp__gmail__send_email");
		expect(connectorToolNames({ connectors: ["Gmail"], available: trimmed, entries })).toEqual(["mcp__gmail__search_threads"]);
	});
});

describe("busca em conector com nomes camelCase (caso real: contas a receber do Bling)", () => {
	const { available, entries } = buildCatalog([
		{ name: "mcp__bling__listAccountReceivables", toolName: "listAccountReceivables", connectorName: "Bling", description: "Obtém contas a receber — Obtém contas a receber paginadas." },
		{ name: "mcp__bling__getAccountReceivableBoletos", toolName: "getAccountReceivableBoletos", connectorName: "Bling", description: "Obtém boletos de contas a receber — Obtém os boletos vinculados a um idOrigem, o qual corresponde ao ID de uma venda ou nota fiscal." },
		{ name: "mcp__bling__createAccountReceivable", toolName: "createAccountReceivable", connectorName: "Bling", description: "Cria uma conta a receber", readOnly: false },
		{ name: "mcp__bling__listSalesOrders", toolName: "listSalesOrders", connectorName: "Bling", description: "Obtém pedidos de vendas paginados." },
		{ name: "mcp__bling__listProposals", toolName: "listProposals", connectorName: "Bling", description: "Obtém propostas comerciais paginadas." },
	]);
	(available.get("mcp__bling__listAccountReceivables")!.function.parameters as { properties: Record<string, unknown> }).properties = {
		situacoes: { description: "`1` Em aberto `2` Recebido", type: "string" },
		tipoFiltroData: { description: "Data de emissão, Data de vencimento ou Data de recebimento", type: "string" },
		boletoGerado: { description: "contas com ou sem boletos emitidos", type: "string" },
	};

	it("'títulos vencidos a receber' acha a listagem de contas a receber", () => {
		const names = searchMcpTools({ query: "titulos vencidos a receber", available, entries }).map((c) => c.name);
		expect(names[0]).toBe("mcp__bling__listAccountReceivables");
	});

	it("'boletos vencidos' acha a listagem (que filtra por vencimento e boleto), não só a de boletos por id", () => {
		const names = searchMcpTools({ query: "boletos vencidos", available, entries }).map((c) => c.name);
		expect(names).toContain("mcp__bling__listAccountReceivables");
	});

	it("o nome em inglês também casa: 'account receivable'", () => {
		const names = searchMcpTools({ query: "account receivable", available, entries }).map((c) => c.name);
		expect(names).toContain("mcp__bling__listAccountReceivables");
	});

	it("tool que pede id carrega junto a leitura da mesma entidade (nunca a de escrita)", () => {
		const extra = findSiblingReadTools({ names: ["mcp__bling__getAccountReceivableBoletos"], available, entries });
		expect(extra).toEqual(["mcp__bling__listAccountReceivables"]);
		expect(extra).not.toContain("mcp__bling__createAccountReceivable");
		expect(findSiblingReadTools({ names: ["mcp__bling__listSalesOrders"], available, entries })).toEqual([]);
	});
});
