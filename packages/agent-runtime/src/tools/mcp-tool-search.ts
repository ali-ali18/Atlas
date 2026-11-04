import type { ChatTool } from "@workspace/llm";

/** Nome + descrição da tool host que carrega tools MCP sob demanda. */
export const MCP_TOOL_SEARCH_TOOL: ChatTool = {
	type: "function",
	function: {
		name: "mcp_tool_search",
		description:
			"Carrega tools de conectores (MCP) pelo nome ou pela necessidade. O " +
			"índice no prompt do sistema lista o que existe em cada conector — " +
			"use esta tool para carregar as que forem úteis antes de chamá-las; " +
			"elas ficam chamáveis a partir do próximo passo.",
		parameters: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description:
						"Palavras-chave da necessidade, ou nome exato de uma ou mais tools " +
						"(exposto ou original), separados por espaço ou vírgula.",
				},
				connector: {
					type: "string",
					description: "Filtra por conector: nome ou slug (ex.: 'Google Drive' ou 'google_drive').",
				},
				limit: {
					type: "integer",
					description: "Máximo de tools a carregar por busca (1-10, padrão 6).",
				},
			},
			required: ["query"],
		},
	},
};

/**
 * Variante com as tools nativas adiadas (economia de contexto): o mesmo nome e os
 * mesmos argumentos, descrição em inglês curta.
 */
export const TOOL_SEARCH_WITH_BUILTINS: ChatTool = {
	type: "function",
	function: {
		name: MCP_TOOL_SEARCH_TOOL.function.name,
		description:
			"Loads tools on demand: built-in tools from the index in the system prompt and connector (MCP) tools, by name or by need. Loaded tools are callable from the next step.",
		parameters: {
			...MCP_TOOL_SEARCH_TOOL.function.parameters,
			properties: {
				...MCP_TOOL_SEARCH_TOOL.function.parameters.properties,
				query: { type: "string", description: "Tool name(s) separated by space or comma, or keywords for the need." },
				connector: { type: "string", description: "Only for connector tools: connector name or slug." },
				limit: { type: "integer", description: "Maximum tools to load per search (1-10, default 6)." },
			},
		},
	},
};
