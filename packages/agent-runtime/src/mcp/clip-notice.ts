/** Aviso de corte de resultado de tool, voltado ao modelo (inglês, neutro e acionável). */

const ARRAY_KEYS = ["data", "items", "results"] as const;

/** Acha o array de itens: raiz ou `data`/`items`/`results`. `start` = índice do `[` no texto. */
function locateItemsArray(text: string): { total: number; start: number } | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (Array.isArray(parsed)) {
		const start = text.indexOf("[");
		return start < 0 ? null : { total: parsed.length, start };
	}
	if (!parsed || typeof parsed !== "object") return null;
	const record = parsed as Record<string, unknown>;
	for (const key of ARRAY_KEYS) {
		const value = record[key];
		if (!Array.isArray(value)) continue;
		const match = new RegExp(String.raw`"${key}"\s*:\s*\[`).exec(text);
		if (!match) continue;
		return { total: value.length, start: match.index + match[0].length - 1 };
	}
	return null;
}

/** Itens completos dentro do prefixo: vírgulas na profundidade 1 do array (o último item pode estar cortado). */
function countCompleteItems(prefix: string, arrayStart: number): number {
	if (arrayStart >= prefix.length) return 0;
	let depth = 0;
	let commas = 0;
	let inString = false;
	let escaped = false;
	for (let i = arrayStart; i < prefix.length; i++) {
		const ch = prefix[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "[" || ch === "{") depth++;
		else if (ch === "]" || ch === "}") depth--;
		else if (ch === "," && depth === 1) commas++;
	}
	return commas;
}

/** "showing N of M items" quando o texto é JSON com array reconhecível; senão null. */
export function describeClippedItems(text: string, shownChars: number): { shown: number; total: number } | null {
	const located = locateItemsArray(text);
	if (!located) return null;
	return { shown: Math.min(countCompleteItems(text.slice(0, shownChars), located.start), located.total), total: located.total };
}

/** Dica opcional e específica da tool (parâmetro de página, filtros), montada a partir do schema. */
export type ClipHintFn = (info: { shownItems: number | null }) => string | null;

export function buildClipNotice(text: string, shownChars: number, hint?: ClipHintFn): string {
	const items = describeClippedItems(text, shownChars);
	const itemsPart = items ? ` (${items.shown} of ${items.total} items)` : "";
	const extra = hint?.({ shownItems: items?.shown ?? null });
	return `[Result truncated: showing ~${shownChars} of ${text.length} characters${itemsPart}. Do not conclude about items not shown — narrow the query (filters, search term) or fetch further pages before answering.${extra ? ` ${extra}` : ""}]`;
}

/** Corta em `maxChars` e anexa o aviso; abaixo do limite devolve o texto intacto. */
export function clipWithNotice(text: string, maxChars: number, hint?: ClipHintFn): { text: string; truncated: boolean } {
	if (text.length <= maxChars) return { text, truncated: false };
	return { text: `${text.slice(0, maxChars)}\n${buildClipNotice(text, maxChars, hint)}`, truncated: true };
}
