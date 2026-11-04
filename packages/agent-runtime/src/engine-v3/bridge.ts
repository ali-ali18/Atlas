import type { ChatTool } from "@workspace/llm";
import { toolSignature } from "./failures.js";

/**
 * Ponte do motor v3 (desenho 3.2): `tool_search` (ranking lexical determinístico, sem LLM) e a validação dos args de
 * `tool_call` pelo schema. Funções puras; o laço (`tools-step.ts`) executa a tool real com o nome real, então
 * política, journal, eventos e cards nunca veem "tool_call".
 */

/** Uma tool que o modelo pode chamar neste run (núcleo ou manifesto), já filtrada pela política. */
export type CatalogEntry = {
	name: string;
	tool: ChatTool;
	source: "native" | "connector";
	/** Nome do conector (com a conta, se houver mais de uma). */
	connector?: string;
	/** Família da tool nativa (grupo do catálogo) para o manifesto. */
	family?: string;
	/** Primeira frase da descrição, curta (manifesto e busca). */
	summary: string;
	/** Termos extras de busca (palavras distintivas do grupo nativo, en/pt/es). */
	keywords?: readonly string[];
};

export const TOOL_SEARCH_LIMIT = 8;

/** Minúsculas, sem acento, quebrado em palavras (snake, camel, `mcp__slug__nome`). */
export function searchTokens(text: string): string[] {
	return text
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((token) => token.length >= 2);
}

const near = (a: string, b: string) => a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a));

type Ranked = { entry: CatalogEntry; score: number };

/**
 * Pontua cada tool contra a consulta do MODELO (argumento da tool, não texto do usuário): nome exato vence tudo;
 * palavra no nome vale 3, parecida no nome 2, palavra do grupo 2, na descrição ou no conector 1.
 * Empate: nativa antes de conector (decisão pendente do dono "tools do sistema como preferência", aplicada só como
 * desempate), depois a mais usada por este bot, depois o nome.
 */
export function rankTools(query: string, entries: readonly CatalogEntry[], usage: Readonly<Record<string, number>> = {}, limit = TOOL_SEARCH_LIMIT): CatalogEntry[] {
	const wanted = [...new Set(searchTokens(query))];
	const exact = query.trim().toLowerCase();
	if (wanted.length === 0 && !exact) return [];
	const ranked: Ranked[] = [];
	for (const entry of entries) {
		if (entry.name.toLowerCase() === exact) {
			ranked.push({ entry, score: 1_000 });
			continue;
		}
		const name = new Set(searchTokens(entry.name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, "")));
		const description = new Set(searchTokens(entry.tool.function.description));
		const keywords = new Set((entry.keywords ?? []).flatMap(searchTokens));
		const connector = new Set(searchTokens(entry.connector ?? ""));
		let score = 0;
		for (const token of wanted) {
			if (name.has(token)) score += 3;
			else if ([...name].some((part) => near(part, token))) score += 2;
			if (keywords.has(token)) score += 2;
			if (description.has(token)) score += 1;
			if (connector.has(token)) score += 1;
		}
		if (score > 0) ranked.push({ entry, score });
	}
	const nativeFirst = (entry: CatalogEntry) => (entry.source === "native" ? 0 : 1);
	ranked.sort(
		(a, b) =>
			b.score - a.score ||
			nativeFirst(a.entry) - nativeFirst(b.entry) ||
			(usage[b.entry.name] ?? 0) - (usage[a.entry.name] ?? 0) ||
			a.entry.name.localeCompare(b.entry.name),
	);
	return ranked.slice(0, limit).map((item) => item.entry);
}

/** Teto do texto de `tool_search`: o resultado entra no contexto, então o tamanho é controlado. */
export const TOOL_SEARCH_MAX_CHARS = 3_500;
const EXAMPLE_MAX_CHARS = 200;
const EXAMPLE_MAX_KEYS = 6;

export const NO_TOOL_FOUND_HINT = "no tool for this; tell the user it isn't available yet; propose_connector only if the user asked to connect a new app.";

function schemaType(schema: unknown): string {
	if (!schema || typeof schema !== "object") return "any";
	const record = schema as { type?: unknown; enum?: unknown; items?: unknown };
	if (Array.isArray(record.enum) && record.enum.length > 0) return record.enum.slice(0, 6).map((value) => JSON.stringify(value)).join(" | ");
	if (Array.isArray(record.type)) return record.type.join(" | ");
	if (record.type === "array") return `${schemaType(record.items)}[]`;
	return typeof record.type === "string" ? record.type : "any";
}

function exampleValue(schema: unknown): unknown {
	const record = (schema && typeof schema === "object" ? schema : {}) as { type?: unknown; enum?: unknown };
	if (Array.isArray(record.enum) && record.enum.length > 0) return record.enum[0];
	const type = Array.isArray(record.type) ? record.type[0] : record.type;
	if (type === "integer" || type === "number") return 1;
	if (type === "boolean") return true;
	if (type === "array") return [];
	if (type === "object") return {};
	return "...";
}

/** `getSalesOrder({"orderId": 1})`: chamada direta mínima, só com os obrigatórios (até 6, no máximo 200 caracteres). */
export function exampleCall(tool: ChatTool): string {
	const properties = tool.function.parameters.properties ?? {};
	const keys = (tool.function.parameters.required ?? []).slice(0, EXAMPLE_MAX_KEYS);
	const body = JSON.stringify(Object.fromEntries(keys.map((key) => [key, exampleValue(properties[key])])));
	const text = `${tool.function.name}(${body})`;
	return text.length > EXAMPLE_MAX_CHARS ? `${tool.function.name}({...})` : text;
}

/**
 * Texto que `tool_search` devolve ao modelo: para cada tool, o nome exato, a assinatura, os parâmetros obrigatórios
 * com tipo e um exemplo mínimo de chamada direta. Tamanho limitado (corta o que passar do teto, sem cortar no meio).
 */
export function toolSearchText(query: string, results: readonly CatalogEntry[]): string {
	const clipped = query.trim().slice(0, 80);
	if (results.length === 0) return `No tool matches "${clipped}": ${NO_TOOL_FOUND_HINT}`;
	const head = `Tools for "${clipped}". Call one directly by its exact name with only its arguments (tool_call(name, args) also works); never repeat the name inside the arguments.`;
	const blocks: string[] = [];
	let size = head.length;
	for (const [index, entry] of results.entries()) {
		const where = entry.source === "native" ? "built-in" : `connector ${entry.connector ?? ""}`.trim();
		const properties = entry.tool.function.parameters.properties ?? {};
		const required = (entry.tool.function.parameters.required ?? []).slice(0, EXAMPLE_MAX_KEYS).map((key) => `${key} (${schemaType(properties[key])})`);
		const block = [
			`${index + 1}. ${toolSignature(entry.tool)} [${where}]: ${entry.summary}`,
			`   required: ${required.length > 0 ? required.join(", ") : "none"}`,
			`   e.g. ${exampleCall(entry.tool)}`,
		].join("\n");
		if (blocks.length > 0 && size + block.length + 1 > TOOL_SEARCH_MAX_CHARS) {
			blocks.push(`(+${results.length - index} more; narrow the query)`);
			break;
		}
		blocks.push(block);
		size += block.length + 1;
	}
	return [head, ...blocks].join("\n");
}

/**
 * Desembrulho do envelope: `{name, args: {...}}` sem outro campo, com `name` igual a um dos nomes aceitos, vira o
 * objeto interno. Só vale quando a tool não declara `name`/`args` no schema (aí seria um argumento de verdade).
 * Envelope com outro nome é erro (não adivinha); qualquer outra forma passa intacta.
 */
export function unwrapEnvelope(tool: ChatTool, args: Record<string, unknown>, acceptedNames: readonly string[]): { args: Record<string, unknown> } | { error: string } {
	const keys = Object.keys(args);
	const properties = tool.function.parameters.properties ?? {};
	if (keys.length !== 2 || !("name" in args) || !("args" in args) || "name" in properties || "args" in properties) return { args };
	const { name, args: inner } = args;
	let value: unknown = inner;
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			value = undefined;
		}
	}
	const isObject = Boolean(value) && typeof value === "object" && !Array.isArray(value);
	if (typeof name !== "string" || !acceptedNames.includes(name.trim()) || !isObject) {
		return { error: `The arguments look like a tool_call envelope. Pass only the fields of ${tool.function.name}, not name/args` };
	}
	return { args: value as Record<string, unknown> };
}

const INTEGER_TEXT = /^-?\d+$/;
const DECIMAL_TEXT = /^-?\d+(\.\d+)?$/;

/**
 * Coerção segura de 1º nível: texto numérico para campo `integer`/`number` do schema (só dígitos ou decimal válido).
 * Qualquer outra divergência fica como está e cai em `argProblems`.
 */
export function coerceNumericText(tool: ChatTool, args: Record<string, unknown>): Record<string, unknown> {
	const properties = tool.function.parameters.properties ?? {};
	let changed: Record<string, unknown> | undefined;
	for (const [key, value] of Object.entries(args)) {
		const schema = properties[key] as JsonSchema | undefined;
		if (typeof value !== "string" || !schema) continue;
		const types = Array.isArray(schema.type) ? schema.type : [schema.type];
		if (types.includes("string")) continue;
		const wantsInteger = types.includes("integer");
		if (!wantsInteger && !types.includes("number")) continue;
		const text = value.trim();
		if (!(wantsInteger ? INTEGER_TEXT : DECIMAL_TEXT).test(text)) continue;
		const parsed = Number(text);
		if (wantsInteger ? !Number.isSafeInteger(parsed) : !Number.isFinite(parsed)) continue;
		changed ??= { ...args };
		changed[key] = parsed;
	}
	return changed ?? args;
}

type JsonSchema = { type?: unknown; enum?: unknown; items?: unknown };

function typeMatches(schema: JsonSchema, value: unknown): boolean {
	const types = Array.isArray(schema.type) ? schema.type : typeof schema.type === "string" ? [schema.type] : [];
	if (types.length === 0) return true;
	return types.some((type) => {
		if (type === "string") return typeof value === "string";
		if (type === "integer") return typeof value === "number" && Number.isInteger(value);
		if (type === "number") return typeof value === "number" && Number.isFinite(value);
		if (type === "boolean") return typeof value === "boolean";
		if (type === "array") return Array.isArray(value);
		if (type === "object") return typeof value === "object" && value !== null && !Array.isArray(value);
		if (type === "null") return value === null;
		return true;
	});
}

/**
 * Confere os args contra o schema da tool (obrigatórios, tipo e enum do 1º nível; o executor valida o resto).
 * Devolve os problemas em inglês curto; lista vazia = válido.
 */
export function argProblems(tool: ChatTool, args: Record<string, unknown>): string[] {
	const problems: string[] = [];
	const properties = tool.function.parameters.properties ?? {};
	for (const key of tool.function.parameters.required ?? []) {
		if (args[key] === undefined || args[key] === null) problems.push(`missing required ${key}`);
	}
	for (const [key, value] of Object.entries(args)) {
		const schema = properties[key] as JsonSchema | undefined;
		if (!schema || value === undefined || value === null) continue;
		if (!typeMatches(schema, value)) problems.push(`${key} must be ${Array.isArray(schema.type) ? schema.type.join(" or ") : String(schema.type)}`);
		else if (Array.isArray(schema.enum) && !schema.enum.some((option) => option === value)) problems.push(`${key} must be one of ${schema.enum.slice(0, 8).map((option) => JSON.stringify(option)).join(", ")}`);
	}
	return problems.slice(0, 5);
}

/** Primeira frase da descrição, até `max` caracteres (corta na palavra). */
export function firstSentence(description: string, max = 60): string {
	const flat = description.replace(/^\[[^\]]{1,80}\]\s*/, "").replace(/\s+/g, " ").trim();
	const end = flat.search(/[.!?](\s|$)/);
	const sentence = end >= 0 ? flat.slice(0, end) : flat;
	if (sentence.length <= max) return sentence;
	const cut = sentence.slice(0, max - 1);
	const space = cut.lastIndexOf(" ");
	return `${space > max / 2 ? cut.slice(0, space) : cut}…`;
}
