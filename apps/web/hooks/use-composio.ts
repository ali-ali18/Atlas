"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
	ComposioCategoryView,
	ComposioConnectedAppView,
	ComposioStatusView,
	ComposioToolkitView,
} from "@workspace/shared";
import { COMPOSIO_PAGE_SIZE_DEFAULT } from "@workspace/shared";
import {
	disconnectComposioApp,
	getComposioStatus,
	listComposioCategories,
	listComposioConnections,
	listComposioToolkits,
	openMcpOAuthPopup,
	removeComposioKey,
	saveComposioKey,
	startComposioConnect,
	waitMcpOAuthPopup,
} from "@/lib/atlas-api";
import {
	COMPOSIO_FIRST_PAGE,
	composioNextPage,
	composioPageCursor,
	composioPagerForFilter,
	composioPrevPage,
	isComposioConnectUrl,
	type ComposioPager,
} from "@/components/settings/composio-state";

const SEARCH_DEBOUNCE_MS = 300;

export function shouldLoadComposioApps(enabled: boolean, configured: boolean): boolean {
	return enabled && configured;
}

function messageOf(error: unknown, fallback: string): string {
	return error instanceof Error && error.message ? error.message : fallback;
}

type ListQuery = { search: string; category: string; cursor: string | null };

/**
 * Composio: chave (só máscara), catálogo paginado por cursor com busca e
 * categoria, conectar (popup que volta na página de retorno da API) e
 * desconectar. Usado pelas Configurações e pela aba Composio do Marketplace.
 * Sem chave nada além do status é consultado. Mudar busca ou categoria volta
 * para a página 1.
 */
export function useComposio(enabled: boolean) {
	const [status, setStatus] = useState<ComposioStatusView | null>(null);
	const [toolkits, setToolkits] = useState<ComposioToolkitView[]>([]);
	const [connections, setConnections] = useState<ComposioConnectedAppView[]>([]);
	const [categories, setCategories] = useState<ComposioCategoryView[]>([]);
	const [search, setSearchState] = useState("");
	const [category, setCategoryState] = useState("");
	const [pager, setPager] = useState<ComposioPager>(COMPOSIO_FIRST_PAGE);
	const [nextCursor, setNextCursor] = useState<string | null>(null);
	const [totalItems, setTotalItems] = useState<number | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const enabledRef = useRef(enabled);
	enabledRef.current = enabled;
	const [listError, setListError] = useState<string | null>(null);
	const requestRef = useRef(0);
	const queryRef = useRef<ListQuery>({ search, category, cursor: composioPageCursor(pager) });
	queryRef.current = { search, category, cursor: composioPageCursor(pager) };

	const reloadApps = useCallback(async (target: ListQuery = queryRef.current) => {
		if (!enabledRef.current) return;
		const id = ++requestRef.current;
		setLoading(true);
		try {
			const [page, apps] = await Promise.all([
				listComposioToolkits({ ...target, limit: COMPOSIO_PAGE_SIZE_DEFAULT }),
				listComposioConnections(),
			]);
			if (id !== requestRef.current || !enabledRef.current) return;
			setToolkits(page.items);
			setNextCursor(page.nextCursor);
			setTotalItems(page.totalItems);
			setConnections(apps);
			setListError(null);
		} catch (cause) {
			if (id === requestRef.current && enabledRef.current) setListError(messageOf(cause, "Não foi possível listar os apps."));
		} finally {
			if (id === requestRef.current) setLoading(false);
		}
	}, []);

	const reloadStatus = useCallback(async () => {
		try {
			const result = await getComposioStatus();
			if (!enabledRef.current) return;
			setStatus(result);
			setError(null);
		} catch (cause) {
			if (enabledRef.current) setError(messageOf(cause, "Não foi possível carregar o Composio."));
		}
	}, []);

	useEffect(() => {
		if (enabled) void reloadStatus();
		else {
			requestRef.current++;
			setLoading(false);
		}
	}, [enabled, reloadStatus]);

	const configured = status?.configured === true;

	// Categorias são opcionais: se falharem, o filtro só não aparece.
	useEffect(() => {
		if (!shouldLoadComposioApps(enabled, configured)) return;
		let cancelled = false;
		listComposioCategories().then(
			(list) => {
				if (!cancelled) setCategories(list);
			},
			() => {
				if (!cancelled) setCategories([]);
			},
		);
		return () => {
			cancelled = true;
		};
	}, [enabled, configured]);

	// Só a busca por texto espera o debounce; trocar de página ou categoria é imediato.
	const lastSearchRef = useRef(search);
	useEffect(() => {
		if (!shouldLoadComposioApps(enabled, configured)) return;
		const delay = lastSearchRef.current === search ? 0 : SEARCH_DEBOUNCE_MS;
		lastSearchRef.current = search;
		const timer = setTimeout(() => void reloadApps({ search, category, cursor: composioPageCursor(pager) }), delay);
		return () => clearTimeout(timer);
	}, [enabled, configured, search, category, pager, reloadApps]);

	const setSearch = useCallback((value: string) => {
		const previous = queryRef.current;
		if (previous.search === value) return;
		queryRef.current = { ...previous, search: value };
		setSearchState(value);
		setPager((current) => composioPagerForFilter(current, previous, { ...previous, search: value }));
	}, []);

	const setCategory = useCallback((value: string) => {
		const previous = queryRef.current;
		if (previous.category === value) return;
		queryRef.current = { ...previous, category: value };
		setCategoryState(value);
		setPager((current) => composioPagerForFilter(current, previous, { ...previous, category: value }));
	}, []);

	const nextPage = useCallback(() => setPager((current) => composioNextPage(current, nextCursor)), [nextCursor]);
	const prevPage = useCallback(() => setPager(composioPrevPage), []);

	const saveKey = useCallback(async (apiKey: string) => {
		setBusy("key");
		setError(null);
		try {
			setStatus(await saveComposioKey(apiKey));
		} catch (cause) {
			setError(messageOf(cause, "Não foi possível salvar a chave."));
		} finally {
			setBusy(null);
		}
	}, []);

	const removeKey = useCallback(async () => {
		setBusy("key");
		setError(null);
		try {
			await removeComposioKey();
			setToolkits([]);
			setConnections([]);
			setCategories([]);
			setNextCursor(null);
			setTotalItems(null);
			setSearchState("");
			setCategoryState("");
			setPager(COMPOSIO_FIRST_PAGE);
			await reloadStatus();
		} catch (cause) {
			setError(messageOf(cause, "Não foi possível remover a chave."));
		} finally {
			setBusy(null);
		}
	}, [reloadStatus]);

	const connect = useCallback(
		async (slug: string, options: { noAuth?: boolean } = {}) => {
			if (busy) return;
			// O popup abre no clique (antes de qualquer await) para o navegador não bloquear.
			// App sem login não precisa dele: a API só ativa o app.
			const popup = options.noAuth ? null : openMcpOAuthPopup();
			setBusy(slug);
			setError(null);
			try {
				const started = await startComposioConnect(slug);
				if ("enabled" in started) {
					// A API achou que o app não exige login (ex.: Auth_Config_NoAuthApp): fecha o popup aberto.
					popup?.close();
					await Promise.all([reloadApps(), reloadStatus()]);
					return;
				}
				const { redirectUrl } = started;
				if (!isComposioConnectUrl(redirectUrl)) throw new Error("Link de conexão inesperado.");
				const result = await waitMcpOAuthPopup(popup, redirectUrl);
				if (!result.ok && result.error) setError(result.error);
				await Promise.all([reloadApps(), reloadStatus()]);
			} catch (cause) {
				popup?.close();
				setError(messageOf(cause, "Não foi possível conectar o app."));
			} finally {
				setBusy(null);
			}
		},
		[busy, reloadApps, reloadStatus],
	);

	const disconnect = useCallback(
		async (accountId: string) => {
			setBusy(accountId);
			setError(null);
			try {
				await disconnectComposioApp(accountId);
				await Promise.all([reloadApps(), reloadStatus()]);
			} catch (cause) {
				setError(messageOf(cause, "Não foi possível desativar ou desconectar o app."));
			} finally {
				setBusy(null);
			}
		},
		[reloadApps, reloadStatus],
	);

	return {
		status,
		toolkits,
		connections,
		categories,
		search,
		setSearch,
		category,
		setCategory,
		pager,
		nextCursor,
		totalItems,
		nextPage,
		prevPage,
		loading,
		busy,
		error,
		listError,
		saveKey,
		removeKey,
		connect,
		disconnect,
	};
}
