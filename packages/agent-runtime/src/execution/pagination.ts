import { nonSemanticParamNames } from "./arg-key.js";

/**
 * Dica acionável para resultado cortado (L23): lê o `inputSchema` da tool e
 * diz exatamente qual parâmetro pagina e qual o próximo valor; sem paginação,
 * sugere estreitar pelos filtros do schema. Genérico: só nomes de parâmetro.
 */
const PAGE_PARAM = /^(page|pagina|page_?number|page_?no|page_?index)$/i;
const OFFSET_PARAM = /^(offset|start|skip)$/i;
const CURSOR_PARAM = /^(cursor|next_?cursor|page_?token|after)$/i;
const LIMIT_PARAM = /^(limit|per_?page|page_?size|size|count|max_?results|limite)$/i;
const MAX_FILTER_SUGGESTIONS = 3;

type Properties = Record<string, unknown>;

function propertiesOf(schema: unknown): Properties {
	if (typeof schema !== "object" || schema === null) return {};
	const props = (schema as { properties?: unknown }).properties;
	return typeof props === "object" && props !== null ? (props as Properties) : {};
}

function findParam(props: Properties, pattern: RegExp): string | undefined {
	return Object.keys(props).find((name) => pattern.test(name));
}

function numberFrom(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value);
	return undefined;
}

function defaultOf(props: Properties, name: string | undefined): number | undefined {
	if (!name) return undefined;
	const definition = props[name];
	return typeof definition === "object" && definition !== null
		? numberFrom((definition as { default?: unknown }).default)
		: undefined;
}

export type ClipHintInput = {
	schema: unknown;
	/** Args enviados nesta chamada (já podados). */
	args: Record<string, unknown>;
	/** Itens inteiros visíveis no resultado cortado, se conhecido. */
	shownItems: number | null;
	/** Texto original do resultado (procura o cursor da próxima página). */
	text: string;
};

function nextCursorFrom(text: string): string | null {
	const match = /"(?:next_?cursor|nextPageToken|next_?page_?token|cursor)"\s*:\s*"([^"]{1,200})"/i.exec(
		text,
	);
	return match?.[1] ?? null;
}

/** Texto da dica (inglês, neutro) ou null quando o schema não oferece nada. */
export function buildClipHint(input: ClipHintInput): string | null {
	const props = propertiesOf(input.schema);
	const limitName = findParam(props, LIMIT_PARAM);
	const pageName = findParam(props, PAGE_PARAM);
	const offsetName = findParam(props, OFFSET_PARAM);
	const cursorName = findParam(props, CURSOR_PARAM);
	const limitNote = limitName
		? ` If a single page is still cut, lower \`${limitName}\` so it fits.`
		: "";

	if (pageName) {
		const current = numberFrom(input.args[pageName]) ?? defaultOf(props, pageName) ?? 1;
		return `Next page: repeat the same call with ${pageName}=${current + 1}.${limitNote}`;
	}
	if (offsetName) {
		const current = numberFrom(input.args[offsetName]) ?? defaultOf(props, offsetName) ?? 0;
		const step =
			input.shownItems ??
			numberFrom(limitName ? input.args[limitName] : undefined) ??
			defaultOf(props, limitName);
		const value = step !== undefined && step > 0 ? String(current + step) : `${current}+<items shown or ${limitName ?? "limit"}>`;
		return `Next items: repeat the same call with ${offsetName}=${value}.${limitNote}`;
	}
	if (cursorName) {
		const cursor = nextCursorFrom(input.text);
		return `Next page: repeat the same call with ${cursorName}=${cursor ?? "<next cursor from the result>"}.${limitNote}`;
	}

	const skip = nonSemanticParamNames(input.schema);
	const used = new Set(Object.keys(input.args));
	const filters = Object.entries(props)
		.filter(([name, definition]) => {
			if (skip.has(name) || limitName === name) return false;
			if (typeof definition !== "object" || definition === null) return false;
			const type = (definition as { type?: unknown }).type;
			return type === "string" || type === "number" || type === "integer" || type === "boolean";
		})
		.map(([name]) => name)
		.sort((a, b) => Number(used.has(a)) - Number(used.has(b)))
		.slice(0, MAX_FILTER_SUGGESTIONS);
	if (filters.length === 0) return null;
	return `This tool has no pagination parameter. Narrow the query with its filters: ${filters.join(", ")}.`;
}
