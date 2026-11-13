// Busca de tools de conector (pura): o modelo descreve o que quer, recebe o schema só das tools que casam.
// "Só entra no contexto se for usar": a capacidade carrega tools genéricas pequenas; o schema detalhado de cada
// tool MCP só aparece aqui, sob demanda. A busca compara PALAVRAS DO NOME da tool (tokens), não regex sobre texto.
import { toolNameTokens, type McpToolInfo } from "@workspace/shared";

export type SearchableTool = { connection: string; tool: McpToolInfo };

export const TOOL_SEARCH_DEFAULT_LIMIT = 3;
export const TOOL_SEARCH_MAX_LIMIT = 8;
/** Peso do casamento no nome (ou título) contra o da descrição, que é texto de terceiro. */
const NAME_WEIGHT = 3;

/** Palavras da consulta (minúsculas, sem acento, sem repetição). Vazio = consulta inútil. */
export function queryWords(query: string): string[] {
	return [...new Set(toolNameTokens(query))];
}

function scoreTool(words: readonly string[], tool: McpToolInfo): number {
	const nameWords = new Set([...toolNameTokens(tool.name), ...toolNameTokens(tool.title ?? tool.annotations?.title ?? "")]);
	const descriptionWords = new Set(toolNameTokens((tool.description ?? "").slice(0, 600)));
	let score = 0;
	for (const word of words) {
		if (nameWords.has(word)) score += NAME_WEIGHT;
		else if (descriptionWords.has(word)) score += 1;
	}
	return score;
}

/** As tools que mais casam, da melhor para a pior; empate pela ordem estável (conexão, nome). Score 0 não entra. */
export function searchTools(candidates: readonly SearchableTool[], query: string, limit = TOOL_SEARCH_DEFAULT_LIMIT): SearchableTool[] {
	const words = queryWords(query);
	if (words.length === 0) return [];
	const cap = Math.min(Math.max(1, Math.trunc(limit)), TOOL_SEARCH_MAX_LIMIT);
	return candidates
		.map((candidate) => ({ candidate, score: scoreTool(words, candidate.tool) }))
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score || (a.candidate.connection + a.candidate.tool.name < b.candidate.connection + b.candidate.tool.name ? -1 : 1))
		.slice(0, cap)
		.map((entry) => entry.candidate);
}
