/**
 * Poda de argumentos opcionais "neutros" antes de chamar uma tool MCP.
 * O modelo costuma preencher todo parâmetro opcional com 0, "" ou [] e o
 * servidor trata isso como filtro real (ex.: Bling `idLoja: 0` esconde tudo).
 * Função pura: decide o que remover a partir do `inputSchema` da tool.
 */

type Schema = Record<string, unknown>;

export type PrunedArgs = {
	args: Record<string, unknown>;
	/** Caminhos removidos (ex.: `idLoja`, `body.nome`), só para debug. */
	pruned: string[];
};

const ID_NAME = /^id[A-Z_]|Id$|_id$/;

function isRecord(value: unknown): value is Schema {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEmptyValue(value: unknown): boolean {
	if (value === null || value === undefined) return true;
	if (typeof value === "string") return value.trim() === "";
	if (Array.isArray(value)) return value.length === 0;
	return isRecord(value) && Object.keys(value).length === 0;
}

function isZeroId(name: string, value: unknown, schema: Schema | undefined): boolean {
	if (value !== 0 && value !== "0") return false;
	if (!ID_NAME.test(name)) return false;
	if (schema && (Array.isArray(schema.enum) || schema.default === 0 || schema.default === "0")) return false;
	return true;
}

function pruneObject(
	args: Record<string, unknown>,
	schema: Schema | undefined,
	prefix: string,
	pruned: string[],
): Record<string, unknown> {
	const properties = isRecord(schema?.properties) ? (schema.properties as Record<string, unknown>) : {};
	const required = new Set(Array.isArray(schema?.required) ? (schema.required as unknown[]).filter((item): item is string => typeof item === "string") : []);
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args)) {
		const sub = isRecord(properties[key]) ? (properties[key] as Schema) : undefined;
		if (required.has(key)) {
			out[key] = value;
			continue;
		}
		if (isEmptyValue(value) || isZeroId(key, value, sub)) {
			pruned.push(`${prefix}${key}`);
			continue;
		}
		if (isRecord(value) && sub) {
			const nested = pruneObject(value, sub, `${prefix}${key}.`, pruned);
			if (Object.keys(nested).length === 0) {
				pruned.push(`${prefix}${key}`);
				continue;
			}
			out[key] = nested;
			continue;
		}
		out[key] = value;
	}
	return out;
}

export function pruneMcpArgs(args: Record<string, unknown>, inputSchema: unknown): PrunedArgs {
	if (!isRecord(inputSchema)) return { args, pruned: [] };
	const pruned: string[] = [];
	return { args: pruneObject(args, inputSchema, "", pruned), pruned };
}
