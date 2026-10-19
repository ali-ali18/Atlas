/**
 * Dica anexada a uma falha "não encontrado" de tool MCP quando um argumento de id
 * recebeu um número pequeno: costuma ser o número exibido ao usuário (ex.: "#269"),
 * não o id interno. Sem a dica o modelo conclui que a função não existe.
 */

const NOT_FOUND = /\b404\b|not[ _]found|does not exist|n[aã]o (foi )?encontrad|no encontrad|inexistente/i;
const ID_NAME = /^id$|_id$|[a-z]Id$|^id[A-Z_]/;
const ID_DESCRIPTION = /\bids?\b|not the same as/i;
const SMALL_INT_LIMIT = 1_000_000;

function schemaDescription(inputSchema: unknown, name: string): string {
	if (typeof inputSchema !== "object" || inputSchema === null) return "";
	const properties = (inputSchema as { properties?: unknown }).properties;
	if (typeof properties !== "object" || properties === null) return "";
	const property = (properties as Record<string, unknown>)[name];
	if (typeof property !== "object" || property === null) return "";
	const description = (property as { description?: unknown }).description;
	return typeof description === "string" ? description : "";
}

function smallInteger(value: unknown): boolean {
	const number = typeof value === "number" ? value : typeof value === "string" && /^\d{1,7}$/.test(value.trim()) ? Number(value) : NaN;
	return Number.isInteger(number) && number >= 0 && number < SMALL_INT_LIMIT;
}

export function idArgNotFoundHint(errorText: string, args: Record<string, unknown>, inputSchema: unknown): string | null {
	if (!NOT_FOUND.test(errorText)) return null;
	for (const [name, value] of Object.entries(args)) {
		if (!smallInteger(value)) continue;
		if (!ID_NAME.test(name) && !ID_DESCRIPTION.test(schemaDescription(inputSchema, name))) continue;
		return `Not found. The argument "${name}" expects an internal resource id, which is not the same as the number or name shown to users. Do not conclude the feature is unavailable. Find the resource's id field in a read, list or search result and retry with it; if no tool returns that id, tell the user what is missing.`;
	}
	return null;
}
