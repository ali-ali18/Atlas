/** Aviso na janela de que uma página foi criada ou atualizada (a lista da Biblioteca recarrega). */
export const PAGES_REFRESH_EVENT = "atlas:pages-refresh";

export function notifyPagesChanged(): void {
	if (typeof window !== "undefined") window.dispatchEvent(new Event(PAGES_REFRESH_EVENT));
}
