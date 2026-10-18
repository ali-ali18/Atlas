/**
 * Dica anexada ao resultado de uma tool MCP de leitura que volta vazia mesmo
 * tendo filtros opcionais: filtros que ninguém pediu podem esconder tudo.
 */

function isEmptyShape(value: unknown): boolean {
	if (Array.isArray(value)) return value.length === 0;
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	for (const key of ["data", "items", "results"]) {
		if (Array.isArray(record[key]) && (record[key] as unknown[]).length === 0) return true;
	}
	for (const [key, item] of Object.entries(record)) {
		if (/^totalRegistros/i.test(key) && item === 0) return true;
	}
	return false;
}

/** `true` quando o texto é JSON com uma coleção vazia em formato comum. */
export function isEmptyMcpResult(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
	try {
		return isEmptyShape(JSON.parse(trimmed));
	} catch {
		return false;
	}
}

/** Filtros opcionais efetivamente enviados (já podados). */
export function optionalFilterKeys(args: Record<string, unknown>, inputSchema: unknown): string[] {
	const required = new Set<string>(
		typeof inputSchema === "object" && inputSchema !== null && Array.isArray((inputSchema as { required?: unknown }).required)
			? ((inputSchema as { required: unknown[] }).required.filter((item) => typeof item === "string") as string[])
			: [],
	);
	return Object.keys(args).filter((key) => !required.has(key) && key !== "explanation");
}

export function emptyResultHint(text: string, filterKeys: readonly string[]): string | null {
	if (filterKeys.length === 0 || !isEmptyMcpResult(text)) return null;
	return `Empty result with filters {${filterKeys.join(", ")}}. Optional filters you were not asked to use can hide everything. Retry with only the essential filter, then with no filters, then with a partial keyword.`;
}
