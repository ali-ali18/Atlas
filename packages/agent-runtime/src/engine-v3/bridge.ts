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

/** Texto que `tool_search` devolve ao modelo: assinatura + resumo + origem de cada resultado. */
export function toolSearchText(query: string, results: readonly CatalogEntry[]): string {
	const clipped = query.trim().slice(0, 80);
	if (results.length === 0) {
		return `No tool matches "${clipped}". Try other words, or check the tool list in the context message. If nothing fits, tell the user it is not possible and offer an alternative.`;
	}
	const lines = results.map((entry, index) => {
		const where = entry.source === "native" ? "built-in" : `connector ${entry.connector ?? ""}`.trim();
		return `${index + 1}. ${toolSignature(entry.tool)} [${where}]: ${entry.summary}`;
	});
	return [`Tools for "${clipped}". Call one with tool_call(name, args) using its exact name:`, ...lines].join("\n");
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
