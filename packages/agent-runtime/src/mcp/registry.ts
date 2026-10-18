import type { ChatTool } from "@workspace/llm";
import {
	connectorAccountName,
	decideAction,
	mcpAutonomyMeta,
	mcpToolName,
	type ActionClass,
	type AutonomyToolMeta,
	type EffectiveAutonomy,
	type McpToolInfo,
} from "@workspace/shared";

/**
 * Conexões → `ChatTool[]` expostas ao modelo + mapa de resolução.
 * Puro (sem rede/banco): o worker passa as conexões "connected" já lidas.
 *
 * "Índice + carregar sob demanda": o catálogo (`available`/`entries`/`index`)
 * cobre TODAS as tools elegíveis, sem teto. `tools` (o que entra no prompt
 * desde o passo 1) só tem todas elas quando cabem no orçamento ativo
 * (`maxTools`/`maxToolsJsonChars`); senão fica vazio e `deferred = true` — o
 * runtime expõe `mcp_tool_search` para carregar sob demanda (mcp/activation.ts).
 */

export const MCP_MAX_EXPOSED_TOOLS = 40;
/** Sem política carregada (testes, chamadas antigas): Equilibrado. */
const DEFAULT_MCP_AUTONOMY: EffectiveAutonomy = { level: "balanced", exceptions: [] };
/** Teto do JSON das definições MCP (entra no prompt a cada passo). */
export const MCP_MAX_TOOLS_JSON_CHARS = 60_000;
/** Descrição completa da tool (instruções como "chame X antes"); o schema nunca é cortado. */
export const DESCRIPTION_MAX_CHARS = 4_000;
/** Resumo de índice: uma linha curta, sem o prefixo `[Conector]`. */
const INDEX_SUMMARY_MAX_CHARS = 100;

export type McpToolsetConnection = {
	id: string;
	slug: string;
	name: string;
	tools: McpToolInfo[];
	disabledTools: string[];
	/** OBSOLETO (F10): a política de autonomia decide. Ignorado. */
	confirmWrites?: boolean;
	catalogId?: string | null;
	/** Apelido da conta (várias contas do mesmo serviço). */
	accountLabel?: string | null;
};

export type McpToolEntry = {
	connectionId: string;
	connectionName: string;
	/** Nome original no servidor MCP. */
	toolName: string;
	readOnly: boolean;
	/** Classe da ação (F10): leitura, escrita reversível ou irreversível. */
	actionClass: ActionClass;
	/** Chaves para exceções da política (slug e catalogId do conector + nome exposto). */
	autonomyMeta: AutonomyToolMeta;
	/** Pede confirmação do usuário antes de executar (decisão `ask` da política no momento da montagem). */
	requiresConfirmation: boolean;
};

export type McpIndexTool = {
	/** Nome exposto (`mcp__<slug>__<tool>`). */
	name: string;
	/** Nome original no servidor MCP. */
	toolName: string;
	/** Descrição curta (~100 chars, uma linha) para o índice do prompt. */
	summary: string;
	readOnly: boolean;
};

export type McpIndexConnector = {
	connectorName: string;
	slug: string;
	tools: McpIndexTool[];
};

export type McpToolset = {
	/** Tools expostas ao modelo desde o passo 1 (vazio quando `deferred`). */
	tools: ChatTool[];
	/** TODAS as tools elegíveis (nome exposto → definição completa), sem teto. */
	available: Map<string, ChatTool>;
	/** TODAS as tools elegíveis (nome exposto → resolução), sem teto. */
	entries: Map<string, McpToolEntry>;
	/** Índice compacto por conector, em ordem de conexão (para o prompt). */
	index: McpIndexConnector[];
	/** Tools que ficaram de fora da exposição inicial (nome exposto). */
	omitted: string[];
	/** Nomes dos conectores com ao menos uma tool elegível (para o prompt). */
	connectorNames: string[];
	/** Serviços com mais de uma conta conectada (nome base): o prompt manda perguntar qual usar. */
	multiAccountServices?: string[];
	/** `true` quando o catálogo não coube no orçamento ativo: `tools` começa vazio. */
	deferred: boolean;
};

export type BuildMcpToolsetOptions = {
	/** Política de autonomia efetiva (padrão: Equilibrado). `block` tira a tool. */
	autonomy?: EffectiveAutonomy;
	/**
	 * Sem humano para confirmar (rotina/webhook): só entram as tools cuja
	 * decisão é `allow`. As de `ask` ficam fora.
	 */
	unattended?: boolean;
	maxTools?: number;
	maxToolsJsonChars?: number;
};

function toParameters(schema: Record<string, unknown>): ChatTool["function"]["parameters"] {
	const properties =
		schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
			? (schema.properties as Record<string, unknown>)
			: {};
	const required = Array.isArray(schema.required)
		? schema.required.filter((item): item is string => typeof item === "string")
		: undefined;
	return {
		...schema,
		type: "object",
		properties,
		...(required && required.length > 0 ? { required } : {}),
	};
}

function toolDescription(connectionName: string, tool: McpToolInfo): string {
	const body = tool.description?.trim() || tool.title?.trim() || tool.name;
	return `[${connectionName}] ${body}`.slice(0, DESCRIPTION_MAX_CHARS);
}

/** Descrição curta, uma linha, sem o prefixo `[Conector]` — para o índice. */
function indexSummary(tool: McpToolInfo): string {
	const body = tool.description?.trim() || tool.title?.trim() || tool.name;
	return body.replace(/\s+/g, " ").trim().slice(0, INDEX_SUMMARY_MAX_CHARS);
}

export function buildMcpToolset(
	connections: readonly McpToolsetConnection[],
	options: BuildMcpToolsetOptions = {},
): McpToolset {
	const maxTools = options.maxTools ?? MCP_MAX_EXPOSED_TOOLS;
	const maxJson = options.maxToolsJsonChars ?? MCP_MAX_TOOLS_JSON_CHARS;
	const autonomy = options.autonomy ?? DEFAULT_MCP_AUTONOMY;
	const available = new Map<string, ChatTool>();
	const entries = new Map<string, McpToolEntry>();
	const connectorNames: string[] = [];
	const index: McpIndexConnector[] = [];
	let totalJsonChars = 0;
	// Várias contas do mesmo serviço: o modelo vê "Notion — Notion pessoal" (sem apelido, cai no slug).
	const perService = new Map<string, number>();
	for (const connection of connections) perService.set(connection.name, (perService.get(connection.name) ?? 0) + 1);
	const multiAccountServices = [...perService].filter(([, count]) => count > 1).map(([name]) => name);

	for (const source of connections) {
		const multi = (perService.get(source.name) ?? 0) > 1;
		const connection =
			multi || source.accountLabel?.trim()
				? { ...source, name: connectorAccountName(source.name, source.accountLabel?.trim() || (multi ? source.slug : null)) }
				: source;
		const disabled = new Set(connection.disabledTools);
		const indexTools: McpIndexTool[] = [];
		for (const tool of connection.tools) {
			if (disabled.has(tool.name)) continue;
			const name = mcpToolName(connection.slug, tool.name);
			if (available.has(name)) continue;
			// Servidor sem `readOnlyHint` (ex.: Firecrawl): o catálogo diz o que só lê.
			const autonomyMeta = mcpAutonomyMeta({
				tool,
				exposedName: name,
				slug: connection.slug,
				catalogId: connection.catalogId,
			});
			const decision = decideAction(autonomy, autonomyMeta);
			if (decision === "block") continue;
			if (options.unattended && decision !== "allow") continue;
			const readOnly = autonomyMeta.actionClass === "read";
			const chatTool: ChatTool = {
				type: "function",
				function: {
					name,
					description: toolDescription(connection.name, tool),
					parameters: toParameters(tool.inputSchema),
				},
			};
			available.set(name, chatTool);
			entries.set(name, {
				connectionId: connection.id,
				connectionName: connection.name,
				toolName: tool.name,
				readOnly,
				actionClass: autonomyMeta.actionClass,
				autonomyMeta,
				requiresConfirmation: decision === "ask",
			});
			totalJsonChars += JSON.stringify(chatTool).length;
			indexTools.push({
				name,
				toolName: tool.name,
				summary: indexSummary(tool),
				readOnly,
			});
		}
		if (indexTools.length > 0) {
			connectorNames.push(connection.name);
			index.push({ connectorName: connection.name, slug: connection.slug, tools: indexTools });
		}
	}

	const fits = available.size <= maxTools && totalJsonChars <= maxJson;
	const deferred = !fits;
	const tools = deferred ? [] : [...available.values()];
	const omitted = deferred ? [...available.keys()] : [];

	return { tools, available, entries, index, omitted, connectorNames, deferred, ...(multiAccountServices.length > 0 ? { multiAccountServices } : {}) };
}
