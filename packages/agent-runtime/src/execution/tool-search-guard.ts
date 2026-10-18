/**
 * Descoberta redundante: `mcp_tool_search` cuja consulta mira tools que já
 * estão carregadas. Puro: casa a consulta com os nomes (por tokens), sem
 * conhecer conector nenhum. Só responde "já carregada" quando nenhuma tool
 * ainda não carregada casa melhor.
 */
function stem(token: string): string {
	return token.length > 3 && token.endsWith("s") ? token.slice(0, -1) : token;
}

function tokenize(text: string): string[] {
	return text
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((token) => token.length > 0)
		.map(stem);
}

/** Parte própria do nome exposto (`mcp__slug__tool` → `tool`). */
export function ownToolName(exposedName: string): string {
	const parts = exposedName.split("__");
	return parts.length >= 3 ? parts.slice(2).join("__") : exposedName;
}

function targets(queryTokens: Set<string>, exposedName: string): boolean {
	const own = tokenize(ownToolName(exposedName));
	return own.length > 0 && own.every((token) => queryTokens.has(token));
}

export function findAlreadyLoadedTools(input: {
	query: string;
	loaded: readonly string[];
	available: Iterable<string>;
}): string[] {
	const trimmed = input.query.trim();
	if (!trimmed) return [];
	const loadedSet = new Set(input.loaded);
	const exact = input.loaded.filter((name) =>
		trimmed.toLowerCase().includes(name.toLowerCase()),
	);
	const queryTokens = new Set(tokenize(trimmed));
	const matched = new Set(exact);
	for (const name of input.loaded) {
		if (targets(queryTokens, name)) matched.add(name);
	}
	if (matched.size === 0) return [];
	for (const name of input.available) {
		if (!loadedSet.has(name) && targets(queryTokens, name)) return [];
	}
	return [...matched];
}

export function alreadyLoadedSummary(names: readonly string[]): string {
	return `Already loaded: ${names.join(", ")}. Call them directly.`;
}
