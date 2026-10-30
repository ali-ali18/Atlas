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
		/** Aba de subagente da requisição em curso (undefined = aba do pai). */
		currentTabId: () => storage.getStore()?.tabId,
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

const TABS_ACTIONS = ["list", "switch", "close"];

/** Valida o corpo de `POST /browser/tabs`; inválido vira erro (HTTP 400). */
export function parseTabsRequest(body) {
	const action = body?.action;
	if (!TABS_ACTIONS.includes(action)) throw new Error(`action must be one of: ${TABS_ACTIONS.join(", ")}`);
	if (action === "list") return { action };
	const index = body?.index;
	if (!Number.isInteger(index) || index < 1 || index > 99) throw new Error(`${action} needs "index": the tab number from the list (1 or more)`);
	return { action, index };
}

/** Executa a ação nas abas do pai (nunca nas de subagente). */
export async function runTabsAction(session, request) {
	if (request.action === "switch") return { action: "switch", active: await session.switchTab(request.index) };
	if (request.action === "close") return { action: "close", ...(await session.closeMainTab(request.index)) };
	return { action: "list", tabs: await session.listTabs() };
}

/** Cabeçalho que leva o aviso de aba nova/fechada junto de qualquer resposta (texto codificado). */
export const TAB_NOTICE_HEADER = "x-atlas-tab-notice";

/**
 * Aviso de aba nova/fechada (só da aba do pai) vai no cabeçalho da primeira
 * resposta depois do evento, qualquer que seja o endpoint (inclusive imagem).
 */
export function attachTabNotice(session, req, res) {
	if (req.headers["x-atlas-tab"]) return;
	const writeHead = res.writeHead.bind(res);
	res.writeHead = (...args) => {
		const notice = session.takeNotice();
		if (notice) res.setHeader(TAB_NOTICE_HEADER, encodeURIComponent(notice));
		return writeHead(...args);
	};
}
