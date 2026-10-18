import { AsyncLocalStorage } from "node:async_hooks";

/** Teto de abas de subagentes abertas ao mesmo tempo (defesa do servidor; o runtime já limita). */
export const MAX_CHILD_TABS = 6;
/** Aba de filho aberta há mais que isso é esquecida (o run dura minutos): é fechada ao abrir outra. */
export const STALE_TAB_MS = 10 * 60 * 1000;

const TAB_ID = /^t\d{1,6}$/;

/** Id de aba vindo do cabeçalho `x-atlas-tab`; inválido vira erro (não cai na aba do pai). */
export function parseTabHeader(value) {
	if (value === undefined || value === "") return undefined;
	const id = Array.isArray(value) ? value[0] : value;
	if (!TAB_ID.test(String(id))) throw new Error("invalid tab id");
	return String(id);
}

/**
 * Faz `getPage`/`peekPage` obedecerem à aba da requisição: dentro de `run(tabId, fn)`
 * as ações de browser (que chamam `getPage()` sem argumento) caem na aba do filho;
 * sem aba, na página do pai, como sempre.
 */
export function createTabScope(session) {
	const storage = new AsyncLocalStorage();
	return {
		run: (tabId, fn) => storage.run({ tabId }, fn),
		getPage: () => session.getPage(storage.getStore()?.tabId),
		peekPage: () => session.peekPage(storage.getStore()?.tabId),
		async openTab(url) {
			await session.closeStaleTabs?.(STALE_TAB_MS);
			if (session.tabCount() >= MAX_CHILD_TABS) throw new Error("too many open tabs");
			return { tabId: await session.openTab(url) };
		},
		closeTab: (tabId) => session.closeTab(tabId),
	};
}
