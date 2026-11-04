import * as React from "react";
import type { ApiFetch } from "./home-sync";
import { fetchPage } from "./page-api";
import { INITIAL_PAGE_STATE, pageReducer, type PageState } from "./page-state";

/**
 * Carrega um painel pelo id e deixa puxar para atualizar. Só a resposta da chamada mais nova vale (a atrasada não
 * sobrescreve nem some com o aviso), e sair da tela ignora o que ainda estava voando.
 */
export function usePage(apiFetch: ApiFetch, pageId: string): { state: PageState; refresh: () => void; retry: () => void } {
	const [state, dispatch] = React.useReducer(pageReducer, INITIAL_PAGE_STATE);
	const generation = React.useRef(0);
	const load = React.useCallback(() => {
		const mine = ++generation.current;
		fetchPage(apiFetch, pageId).then(
			(page) => mine === generation.current && dispatch({ type: "loaded", page }),
			(error: unknown) => mine === generation.current && dispatch({ type: "failed", error }),
		);
	}, [apiFetch, pageId]);
	React.useEffect(() => {
		load();
		return () => {
			generation.current += 1;
		};
	}, [load]);
	const refresh = React.useCallback(() => {
		dispatch({ type: "refresh" });
		load();
	}, [load]);
	const retry = React.useCallback(() => {
		dispatch({ type: "retry" });
		load();
	}, [load]);
	return { state, refresh, retry };
}
