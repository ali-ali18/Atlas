import { stableReadKey } from "../read-execution.js";

/**
 * Normalização da chave de leitura: parâmetros de texto livre (explicação,
 * justificativa...) mudam a cada chamada sem mudar o resultado. Detectados só
 * pelo `inputSchema` da tool, nunca por nome de conector.
 */
const FREE_TEXT_NAME =
	/^(explanation|reason|rationale|justification|note|notes|comment|purpose|context)$/i;
const FREE_TEXT_DESCRIPTION =
	/\b(explanations?|explain|reasoning|rationale|justification)\b|\bfor (logging|audit|debug(ging)?)\b|\blogging purposes\b/i;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Nomes dos parâmetros string que não alteram o resultado da tool. */
export function nonSemanticParamNames(schema: unknown): Set<string> {
	const names = new Set<string>();
	if (!isRecord(schema) || !isRecord(schema.properties)) return names;
	for (const [name, definition] of Object.entries(schema.properties)) {
		if (!isRecord(definition)) continue;
		if (definition.type !== "string" || Array.isArray(definition.enum)) continue;
		const description =
			typeof definition.description === "string" ? definition.description : "";
		if (FREE_TEXT_NAME.test(name) || FREE_TEXT_DESCRIPTION.test(description)) {
			names.add(name);
		}
	}
	return names;
}

/** Args sem os parâmetros de texto livre (a chamada real segue com todos). */
export function semanticArgs(
	args: Record<string, unknown>,
	schema: unknown,
): Record<string, unknown> {
	const skip = nonSemanticParamNames(schema);
	if (skip.size === 0) return args;
	return Object.fromEntries(
		Object.entries(args).filter(([key]) => !skip.has(key)),
	);
}

/** Chave estável (ordem das chaves e texto livre não contam). */
export function semanticReadKey(
	name: string,
	args: Record<string, unknown>,
	schema: unknown,
): string {
	return stableReadKey(name, semanticArgs(args, schema));
}
