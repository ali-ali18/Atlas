/**
 * Dicas acionáveis anexadas ao erro de uma tool MCP antes de chegar ao modelo
 * (e ao usuário). Uma função pura por conector, indexada pelo `catalogId`.
 * Devolve `null` quando não há dica para aquele erro.
 */

export type McpErrorHintInput = {
	toolName: string;
	args: Record<string, unknown>;
	text: string;
};

type McpErrorHintFn = (input: McpErrorHintInput) => string | null;

export function firecrawlErrorHint({ text }: McpErrorHintInput): string | null {
	return /all scraping engines failed/i.test(text) ? "Tente web_extract ou o navegador para esta URL." : null;
}

export function githubErrorHint({ toolName, args, text }: McpErrorHintInput): string | null {
	if (toolName === "get_file_contents" && /path does not point/i.test(text)) {
		const ref = typeof args.ref === "string" && args.ref.trim() ? args.ref.trim() : "informado";
		return `O caminho não existe no ref \`${ref}\`. Liste a pasta pai com o **mesmo ref** antes (a estrutura pode ser diferente entre branches), ou use \`search_code\`.`;
	}
	if (toolName === "search_commits" && /search text is required/i.test(text)) {
		return "search_commits exige texto de busca; para listar commits recentes use `list_commits` (com `since`/`sha`).";
	}
	return null;
}

const HINTS_BY_CATALOG_ID: Readonly<Record<string, McpErrorHintFn>> = {
	firecrawl: firecrawlErrorHint,
	github: githubErrorHint,
};

/** Texto do erro + dica do conector (se houver). Conector custom/sem dica: texto intacto. */
export function withMcpErrorHint(catalogId: string | undefined, input: McpErrorHintInput): string {
	const hint = catalogId ? HINTS_BY_CATALOG_ID[catalogId]?.(input) : null;
	return hint ? `${input.text}\n${hint}` : input.text;
}
