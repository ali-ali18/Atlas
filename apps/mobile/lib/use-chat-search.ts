import * as React from "react";
import type { ChatItem } from "@/lib/chat-types";
import { clampHit, hitLabel, SEARCH_DEBOUNCE_MS, searchChat, stepHit, type SearchHit } from "@/lib/chat-search";

export type ChatSearch = {
	open: boolean;
	/** Texto do campo (sem debounce). */
	text: string;
	setText: (value: string) => void;
	/** Consulta já com debounce: é a que busca e realça. */
	query: string;
	hits: readonly SearchHit[];
	/** Ocorrência atual (0 a n-1), ou -1 sem resultado. */
	index: number;
	/** Mensagem da ocorrência atual (para rolar até ela e realçar mais forte). */
	activeId: string | null;
	/** "2 de 5". */
	label: string;
	/** Há consulta e nenhum resultado. */
	empty: boolean;
	start: () => void;
	close: () => void;
	next: () => void;
	previous: () => void;
};

/**
 * Estado da busca na conversa: texto do campo, consulta com debounce, ocorrências nas mensagens JÁ carregadas (`items`,
 * em ordem de conversa) e a atual. A primeira ocorrência é a mais recente; ↑/↓ andam dando a volta. Fechar limpa tudo.
 */
export function useChatSearch(items: readonly ChatItem[]): ChatSearch {
	const [open, setOpen] = React.useState(false);
	const [text, setText] = React.useState("");
	const [query, setQuery] = React.useState("");
	const [current, setCurrent] = React.useState(0);

	// Debounce curto na digitação; apagar tudo limpa na hora. Consulta nova volta para a ocorrência mais recente.
	React.useEffect(() => {
		if (!text.trim()) {
			setQuery("");
			setCurrent(0);
			return;
		}
		const timer = setTimeout(() => {
			setQuery(text);
			setCurrent(0);
		}, SEARCH_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [text]);

	const hits = React.useMemo(() => (open ? searchChat(items, query) : []), [open, items, query]);
	const index = clampHit(current, hits.length);
	const start = React.useCallback(() => setOpen(true), []);
	const close = React.useCallback(() => {
		setOpen(false);
		setText("");
		setQuery("");
		setCurrent(0);
	}, []);
	const next = React.useCallback(() => setCurrent(stepHit(index, hits.length, 1)), [index, hits.length]);
	const previous = React.useCallback(() => setCurrent(stepHit(index, hits.length, -1)), [index, hits.length]);

	return {
		open,
		text,
		setText,
		query,
		hits,
		index,
		activeId: open && index >= 0 ? (hits[index]?.itemId ?? null) : null,
		label: hitLabel(index, hits.length),
		empty: open && query.trim().length > 0 && hits.length === 0,
		start,
		close,
		next,
		previous,
	};
}
