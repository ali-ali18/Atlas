/**
 * Validação leve dos argumentos de uma tool MCP contra o `inputSchema` em cache, antes de abrir o
 * card de confirmação (ou de executar uma escrita liberada). Evita o laço "usuário aprova → o
 * sistema externo recusa por campo faltando → repete". Só cobre o que é barato e seguro de checar
 * (obrigatórios, tipo básico, enum, objetos e itens de lista aninhados); `oneOf`/`anyOf`/`$ref`
 * e schemas ausentes são ignorados — na dúvida, não bloqueia.
 */

export type ArgIssue = { path: string; problem: "missing" | "type" | "enum"; expected: string };

const MAX_DEPTH = 6;
const MAX_ISSUES = 12;
const MAX_ARRAY_ITEMS_CHECKED = 20;

type Schema = Record<string, unknown>;

function isRecord(value: unknown): value is Schema {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBlank(value: unknown): boolean {
	return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

function declaredTypes(schema: Schema): string[] {
	const raw = schema.type;
	if (typeof raw === "string") return [raw];
	if (Array.isArray(raw)) return raw.filter((item): item is string => typeof item === "string");
	return [];
}

/** Aceita o que o servidor costuma converter sozinho: "10" para número, "true" para booleano, número para string. */
function matchesType(value: unknown, type: string): boolean {
	switch (type) {
		case "string": return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
		case "number": return (typeof value === "number" && Number.isFinite(value)) || numericString(value) !== undefined;
		case "integer": {
			const n = typeof value === "number" ? value : numericString(value);
			return typeof n === "number" && Number.isInteger(n);
		}
		case "boolean": return typeof value === "boolean" || value === "true" || value === "false";
		case "object": return isRecord(value);
		case "array": return Array.isArray(value);
		case "null": return value === null;
		default: return true;
	}
}

function numericString(value: unknown): number | undefined {
	if (typeof value !== "string" || value.trim() === "") return undefined;
	const n = Number(value.trim());
	return Number.isFinite(n) ? n : undefined;
}

/** String vazia vale em campo obrigatório só quando o schema diz isso de forma explícita. */
function allowsEmptyString(schema: unknown): boolean {
	if (!isRecord(schema)) return false;
	if (schema.minLength === 0) return true;
	return Array.isArray(schema.enum) && schema.enum.includes("");
}

function describeExpected(schema: Schema): string {
	if (Array.isArray(schema.enum)) {
		return `um de: ${schema.enum.slice(0, 12).map((item) => JSON.stringify(item)).join(", ")}`;
	}
	const types = declaredTypes(schema);
	return types.length > 0 ? types.join(" ou ") : "valor";
}

function joinPath(base: string, key: string | number): string {
	if (typeof key === "number") return `${base}[${key}]`;
	return base ? `${base}.${key}` : key;
}

function walk(schema: unknown, value: unknown, path: string, depth: number, issues: ArgIssue[]): void {
	if (issues.length >= MAX_ISSUES || depth > MAX_DEPTH || !isRecord(schema)) return;
	if (schema.oneOf || schema.anyOf || schema.allOf || schema.$ref) return;
	if (Array.isArray(schema.enum) && schema.enum.length > 0) {
		if (!schema.enum.some((option) => option === value)) {
			issues.push({ path, problem: "enum", expected: describeExpected(schema) });
		}
		return;
	}
	const types = declaredTypes(schema);
	if (types.length > 0 && !types.some((type) => matchesType(value, type))) {
		issues.push({ path, problem: "type", expected: types.join(" ou ") });
		return;
	}
	if (isRecord(value) && (types.length === 0 || types.includes("object"))) {
		const properties = isRecord(schema.properties) ? schema.properties : {};
		const required = Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === "string") : [];
		for (const key of required) {
			const sub = properties[key];
			if (isBlank(value[key]) && !(value[key] === "" && allowsEmptyString(sub))) {
				issues.push({ path: joinPath(path, key), problem: "missing", expected: isRecord(sub) ? describeExpected(sub) : "valor" });
				if (issues.length >= MAX_ISSUES) return;
			}
		}
		for (const [key, sub] of Object.entries(properties)) {
			if (isBlank(value[key])) continue;
			walk(sub, value[key], joinPath(path, key), depth + 1, issues);
		}
		return;
	}
	if (Array.isArray(value) && isRecord(schema.items)) {
		value.slice(0, MAX_ARRAY_ITEMS_CHECKED).forEach((item, index) => {
			walk(schema.items, item, joinPath(path, index), depth + 1, issues);
		});
	}
}

/** Lista o que falta ou está inválido; vazio quando tudo confere ou não há schema utilizável. */
export function validateMcpArgs(schema: unknown, args: Record<string, unknown>): ArgIssue[] {
	if (!isRecord(schema)) return [];
	const issues: ArgIssue[] = [];
	walk({ type: "object", ...schema }, args, "", 0, issues);
	return issues;
}

/** Mensagem para o modelo: campos exatos + orientação genérica. `null` quando válido. */
export function mcpArgsErrorMessage(toolName: string, issues: ArgIssue[]): string | null {
	if (issues.length === 0) return null;
	const lines = issues.map((issue) => {
		const field = issue.path || "(argumentos)";
		if (issue.problem === "missing") return `- ${field}: obrigatório e ausente ou vazio (esperado: ${issue.expected})`;
		if (issue.problem === "enum") return `- ${field}: valor inválido (${issue.expected})`;
		return `- ${field}: tipo inválido (esperado: ${issue.expected})`;
	});
	return [
		`Nada foi executado nem enviado para confirmação: "${toolName}" está com argumentos incompletos ou inválidos.`,
		...lines,
		"Obtenha os valores com tools de leitura ou pergunte ao usuário; não peça confirmação nem repita a chamada até ter todos os campos obrigatórios com valores reais.",
	].join("\n");
}
