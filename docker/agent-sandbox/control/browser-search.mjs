// F8.1 — busca dentro da página, feita na VM sobre o texto de TODOS os itens carregados. Todas as palavras precisam bater;
// acento e caixa não contam. Devolve só os trechos, com o número do item; o total de batidas é sempre dito.

export const FIND_DEFAULT_LIMIT = 20;
export const FIND_MAX_LIMIT = 100;
export const SNIPPET_CHARS = 240;

export const normalizeForSearch = (text) =>
	String(text ?? "")
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.toLowerCase();

export function queryWords(query) {
	return normalizeForSearch(query).split(/\s+/).filter(Boolean);
}

/** Trecho de até `max` caracteres em volta da primeira palavra achada; o item curto vai inteiro. */
export function snippetAround(text, words, max = SNIPPET_CHARS) {
	if (text.length <= max) return text;
	const flat = normalizeForSearch(text);
	let at = -1;
	for (const word of words) {
		const i = flat.indexOf(word);
		if (i >= 0 && (at < 0 || i < at)) at = i;
	}
	const start = Math.max(0, Math.min(text.length - max, (at < 0 ? 0 : at) - Math.floor(max / 4)));
	const end = Math.min(text.length, start + max);
	return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/** `texts`: [{n, text}]. Devolve `{ total, matches: [{n, snippet}] }` com no máximo `limit` trechos. */
export function searchItems(texts, query, limit = FIND_DEFAULT_LIMIT) {
	const words = queryWords(query);
	if (words.length === 0) throw new Error("The search needs at least one word.");
	const matches = [];
	let total = 0;
	for (const item of texts) {
		const flat = normalizeForSearch(item.text);
		if (!words.every((word) => flat.includes(word))) continue;
		total += 1;
		if (matches.length < limit) matches.push({ n: item.n, snippet: snippetAround(item.text, words) });
	}
	return { total, matches };
}
