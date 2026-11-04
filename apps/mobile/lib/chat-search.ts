import type { ChatItem } from "@/lib/chat-types";

/** Trecho achado, em índices do texto ORIGINAL (`end` exclusivo). */
export type MatchRange = { start: number; end: number };

/** Uma ocorrência na conversa: a mensagem e o trecho dentro dela. */
export type SearchHit = MatchRange & { itemId: string };

/** Pedaço de texto para desenhar: `match` = trecho achado (vai realçado). */
export type TextPart = { text: string; match: boolean };

/** Debounce da digitação (ms) antes de refazer a busca. */
export const SEARCH_DEBOUNCE_MS = 200;

/**
 * Texto sem acento e em minúsculas, com o mapa de volta ao texto original. Cada caractere original vira 0..n
 * caracteres dobrados; `starts[i]`/`ends[i]` dizem de onde a posição `i` do dobrado veio no original. Assim o realce
 * cai no lugar certo mesmo quando a dobra muda o tamanho (ex.: "ﬁ" vira "fi", "é" decomposto perde o acento).
 */
function fold(text: string): { folded: string; starts: number[]; ends: number[] } {
	let folded = "";
	const starts: number[] = [];
	const ends: number[] = [];
	let index = 0;
	for (const char of text) {
		const piece = char.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
		// Marca de acento solta (texto decomposto) some na dobra: o fim do caractere anterior a absorve, para o realce cobri-la.
		if (!piece && ends.length > 0) ends[ends.length - 1] = index + char.length;
		for (let i = 0; i < piece.length; i += 1) {
			starts.push(index);
			ends.push(index + char.length);
		}
		folded += piece;
		index += char.length;
	}
	return { folded, starts, ends };
}

/** Consulta dobrada e sem espaços nas pontas (vazia = sem busca). */
export function foldQuery(query: string): string {
	return fold(query.trim()).folded;
}

/** Trechos de `text` que casam com `query`, sem acento e sem diferenciar maiúsculas; não se sobrepõem. */
export function findMatches(text: string, query: string): MatchRange[] {
	const needle = foldQuery(query);
	if (!needle) return [];
	const { folded, starts, ends } = fold(text);
	const found: MatchRange[] = [];
	let from = 0;
	for (;;) {
		const at = folded.indexOf(needle, from);
		if (at < 0) break;
		const last = at + needle.length - 1;
		found.push({ start: starts[at] as number, end: ends[last] as number });
		from = at + needle.length;
	}
	return found;
}

/** Texto pesquisável da linha: só fala do usuário e do bot; cartões sem texto ficam de fora. */
export function searchableText(item: ChatItem): string | null {
	if (item.kind !== "user" && item.kind !== "assistant") return null;
	return item.text.trim() ? item.text : null;
}

/**
 * Todas as ocorrências, da mais recente para a mais antiga (a primeira é a do fim da conversa). `items` vem em ordem de
 * conversa (antiga primeiro); dentro de uma mensagem, as ocorrências seguem a ordem de leitura.
 */
export function searchChat(items: readonly ChatItem[], query: string): SearchHit[] {
	if (!foldQuery(query)) return [];
	const hits: SearchHit[] = [];
	for (let i = items.length - 1; i >= 0; i -= 1) {
		const item = items[i] as ChatItem;
		const text = searchableText(item);
		if (!text) continue;
		for (const range of findMatches(text, query)) hits.push({ itemId: item.id, ...range });
	}
	return hits;
}

/** Vai para a ocorrência anterior/próxima dando a volta (`direction` -1 ou 1). Sem ocorrências: -1. */
export function stepHit(current: number, total: number, direction: -1 | 1): number {
	if (total <= 0) return -1;
	if (current < 0) return direction === 1 ? 0 : total - 1;
	return (current + direction + total) % total;
}

/** Mantém a ocorrência atual válida quando a lista muda (chegou mensagem, a consulta mudou). */
export function clampHit(current: number, total: number): number {
	if (total <= 0) return -1;
	return current < 0 ? 0 : Math.min(current, total - 1);
}

/** "2 de 5" (posição humana, começa em 1); vazio quando não há ocorrência atual. */
export function hitLabel(current: number, total: number): string {
	return total > 0 && current >= 0 ? `${current + 1} de ${total}` : "";
}

/** Quebra `text` em pedaços normais e achados, para o realce. Sem consulta ou sem achado: um pedaço só. */
export function highlightParts(text: string, query: string): TextPart[] {
	const ranges = findMatches(text, query);
	if (ranges.length === 0) return [{ text, match: false }];
	const parts: TextPart[] = [];
	let cursor = 0;
	for (const range of ranges) {
		if (range.start > cursor) parts.push({ text: text.slice(cursor, range.start), match: false });
		parts.push({ text: text.slice(range.start, range.end), match: true });
		cursor = range.end;
	}
	if (cursor < text.length) parts.push({ text: text.slice(cursor), match: false });
	return parts;
}
