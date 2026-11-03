// Estado da tela de um painel: carregando, pronto (com atualização em curso) ou erro. Puro e testado; o hook
// (`use-page.ts`) só liga isto à rede.
import { ChatApiError } from "./chat-api";
import { type PageData, pageErrorRetryable, pageErrorText } from "./page-api";

export type PageState =
	| { status: "loading" }
	| { status: "ready"; page: PageData; refreshing: boolean; refreshError: string | null }
	| { status: "error"; message: string; retryable: boolean };

export type PageAction = { type: "loaded"; page: PageData } | { type: "failed"; error: unknown } | { type: "refresh" } | { type: "retry" };

export const INITIAL_PAGE_STATE: PageState = { status: "loading" };

/** Qual versão fica na tela: a nova só vale se não for mais antiga (uma resposta atrasada não desfaz uma revisão nova). */
export function pickNewer(current: PageData, next: PageData): PageData {
	return next.revision >= current.revision ? next : current;
}

export function pageReducer(state: PageState, action: PageAction): PageState {
	switch (action.type) {
		case "loaded":
			return { status: "ready", page: state.status === "ready" ? pickNewer(state.page, action.page) : action.page, refreshing: false, refreshError: null };
		case "refresh":
			return state.status === "ready" ? { ...state, refreshing: true, refreshError: null } : state;
		case "retry":
			return { status: "loading" };
		case "failed": {
			// Painel apagado: some da tela mesmo que já estivesse aberto.
			const gone = action.error instanceof ChatApiError && (action.error.status === 404 || action.error.status === 401);
			if (state.status === "ready" && !gone) return { ...state, refreshing: false, refreshError: "Não consegui atualizar agora." };
			return { status: "error", message: pageErrorText(action.error), retryable: pageErrorRetryable(action.error) };
		}
	}
}
