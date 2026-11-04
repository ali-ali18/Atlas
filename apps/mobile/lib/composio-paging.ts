// Paginação da lista do Composio, em funções puras (o hook só guarda o estado e faz o pedido). Antes, a rolagem podia
// encadear páginas sem parar: cada página nova (quase toda filtrada, pois os apps nativos e os conectados saem da lista)
// mal crescia a tela, o fim continuava à vista e `onEndReached` puxava a próxima, até baixar o catálogo inteiro. Cada
// página refazia o merge, o mapa de logos e todas as linhas (custo cresce com o total) e a thread JS parava de responder
// (nem o X tocava). Guardas: um pedido por vez, fim ao cursor repetido ou página sem novidade, teto de páginas.
import type { ComposioPage, ComposioToolkit } from "./apps-parse";
import { mergeToolkits } from "./apps";

/** Teto de páginas por busca/categoria: mais que isso é laço do servidor, não catálogo. */
export const MAX_PAGES = 40;

/** Itens que uma página pode trazer (o app pede 20): o servidor que ignorar o limite não entrega o catálogo à thread JS. */
export const MAX_PAGE_ITEMS = 50;
/** Itens do Composio guardados (e renderizados) por busca/categoria; passou disso, a pessoa refina pela busca. */
export const MAX_ITEMS = 300;

export type Paging = {
	items: readonly ComposioToolkit[];
	/** Cursor da próxima página; `null` = não há (ou ainda não houve primeira página). */
	cursor: string | null;
	loading: boolean;
	done: boolean;
	pages: number;
	/** Cursores já usados: se o servidor devolver um deles de novo, a lista acabou. */
	seen: readonly string[];
};

export const EMPTY_PAGING: Paging = { items: [], cursor: null, loading: false, done: false, pages: 0, seen: [] };

/** Descarta o excesso de uma página: sem custo proporcional ao que o servidor mandar. */
export function clampPage(page: ComposioPage): ComposioPage {
	return page.items.length <= MAX_PAGE_ITEMS ? page : { ...page, items: page.items.slice(0, MAX_PAGE_ITEMS) };
}

/** Só pede a próxima página se nenhuma está a caminho, a lista não acabou e há cursor. */
export function canLoadMore(paging: Paging): boolean {
	return !paging.loading && !paging.done && paging.cursor !== null && paging.pages < MAX_PAGES;
}

export function startMore(paging: Paging): Paging {
	return { ...paging, loading: true };
}

/** Aplica uma página. `requested` é o cursor pedido (`null` na primeira). Página sem item novo ou cursor repetido = fim. */
export function applyPage(paging: Paging, page: ComposioPage, requested: string | null): Paging {
	const clamped = clampPage(page);
	// Página que veio grande demais: o cursor do servidor pularia o que foi descartado, então a lista acaba aqui.
	const oversized = clamped !== page;
	const merged = mergeToolkits(paging.items, clamped.items);
	const full = merged.length >= MAX_ITEMS;
	const items = full ? merged.slice(0, MAX_ITEMS) : merged;
	const seen = requested === null ? paging.seen : [...paging.seen, requested];
	const next = page.nextCursor;
	const stalled = oversized || full || next === null || next === requested || seen.includes(next) || items.length === paging.items.length;
	const pages = paging.pages + 1;
	return { items, cursor: stalled ? null : next, loading: false, done: stalled || pages >= MAX_PAGES, pages, seen };
}

/** Falhou a página seguinte: mantém o que há e o cursor, para tentar de novo. */
export function failMore(paging: Paging): Paging {
	return { ...paging, loading: false };
}

/**
 * Porta do `onEndReached`: só deixa passar uma página por gesto do usuário. Começa armada (a primeira rolagem não exige
 * arrastar); cada disparo desarma e só um arrasto/inércia (`arm`) rearma. Impede a corrente de páginas sem o dedo.
 */
export function createEndReachedGate(): { arm: () => void; take: () => boolean } {
	let armed = true;
	return {
		arm: () => void (armed = true),
		take: () => {
			if (!armed) return false;
			armed = false;
			return true;
		},
	};
}
