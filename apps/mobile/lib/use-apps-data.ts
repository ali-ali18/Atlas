import * as React from "react";
import { appsErrorText, fetchComposioCategories, fetchComposioConfigured, fetchComposioConnections, fetchComposioToolkits, fetchMcpCatalog, fetchMcpConnections } from "./apps-api";
import type { ComposioCategory, ComposioConnection, ComposioToolkit, McpConnection, NativeConnector } from "./apps-parse";
import { type ComposioState, mergeToolkits } from "./apps";
import { useAtlasSession } from "./atlas-session";
import { fetchCatalog } from "./catalog-api";
import type { CatalogBot } from "./catalog";
import { isUnauthorized } from "./chat-api";

export type AppsData = {
	status: "loading" | "ready" | "error";
	error: string | null;
	entries: NativeConnector[];
	connections: McpConnection[];
	composioConfigured: boolean;
	composioConnections: ComposioConnection[];
	composioCategories: ComposioCategory[];
	/** `null` = o catálogo de bots não carregou (a seção some, sem erro). */
	bots: CatalogBot[] | null;
};

const EMPTY: AppsData = { status: "loading", error: null, entries: [], connections: [], composioConfigured: false, composioConnections: [], composioCategories: [], bots: null };

/**
 * Tudo o que a tela de aplicativos e o detalhe leem: catálogo nativo, conexões, estado do Composio e bots. O catálogo
 * nativo é o único obrigatório; o resto é "se vier, melhor". `reload()` relê em silêncio (sem voltar ao "carregando").
 */
export function useAppsData(): AppsData & { reload: () => Promise<void> } {
	const { apiFetch, signOut } = useAtlasSession();
	const [data, setData] = React.useState<AppsData>(EMPTY);
	const latest = React.useRef({ apiFetch, signOut });
	latest.current = { apiFetch, signOut };
	const mounted = React.useRef(true);
	React.useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	const reload = React.useCallback(async () => {
		const { apiFetch: fetcher } = latest.current;
		try {
			const [entries, connections, composioConfigured, bots] = await Promise.all([
				fetchMcpCatalog(fetcher),
				fetchMcpConnections(fetcher).catch((reason) => {
					if (isUnauthorized(reason)) throw reason;
					return [] as McpConnection[];
				}),
				fetchComposioConfigured(fetcher),
				fetchCatalog(fetcher).catch((reason) => {
					if (isUnauthorized(reason)) throw reason;
					return null;
				}),
			]);
			const [composioConnections, composioCategories] = composioConfigured
				? await Promise.all([fetchComposioConnections(fetcher).catch(() => [] as ComposioConnection[]), fetchComposioCategories(fetcher)])
				: [[] as ComposioConnection[], [] as ComposioCategory[]];
			if (mounted.current) setData({ status: "ready", error: null, entries, connections, composioConfigured, composioConnections, composioCategories, bots });
		} catch (reason) {
			if (isUnauthorized(reason)) void latest.current.signOut();
			// Já havia dados: a falha de uma releitura não derruba a tela.
			if (mounted.current) setData((current) => (current.status === "ready" ? current : { ...EMPTY, status: "error", error: appsErrorText(reason, "list") }));
		}
	}, []);
	return { ...data, reload };
}

/** Atraso de digitação antes de perguntar ao servidor (o filtro local não espera). */
export function useDebounced<T>(value: T, ms: number): T {
	const [debounced, setDebounced] = React.useState(value);
	React.useEffect(() => {
		const timer = setTimeout(() => setDebounced(value), ms);
		return () => clearTimeout(timer);
	}, [value, ms]);
	return debounced;
}

const PAGE = 20;

/**
 * Lista de apps do Composio (paginada): recomeça quando a busca ou a categoria mudam. Sem Composio ativo (ou 409 do
 * servidor) fica `off`. `reset` relê do começo (depois de conectar, para o "Conectado" certo).
 */
export function useComposioList(options: { enabled: boolean; query: string; category: string | null }): { state: ComposioState; loadMore: () => void; retry: () => void; logos: ReadonlyMap<string, string | null> } {
	const { apiFetch, signOut } = useAtlasSession();
	const { enabled, query, category } = options;
	const [state, setState] = React.useState<ComposioState>({ status: "loading" });
	const [attempt, setAttempt] = React.useState(0);
	const [logos, setLogos] = React.useState<ReadonlyMap<string, string | null>>(new Map());
	const cursor = React.useRef<string | null>(null);
	const generation = React.useRef(0);
	const latest = React.useRef({ apiFetch, signOut });
	latest.current = { apiFetch, signOut };

	React.useEffect(() => {
		const mine = ++generation.current;
		cursor.current = null;
		if (!enabled) {
			setState({ status: "off" });
			return;
		}
		setState({ status: "loading" });
		fetchComposioToolkits(latest.current.apiFetch, { search: query, category, limit: PAGE }).then(
			(page) => {
				if (mine !== generation.current) return;
				cursor.current = page.nextCursor;
				setState({ status: "ready", items: page.items, hasMore: page.nextCursor !== null, loadingMore: false });
				setLogos((current) => withLogos(current, page.items));
			},
			(reason) => {
				if (mine !== generation.current) return;
				if (isUnauthorized(reason)) void latest.current.signOut();
				setState(reason && (reason as { status?: number }).status === 409 ? { status: "off" } : { status: "error" });
			},
		);
	}, [enabled, query, category, attempt]);

	const loadMore = React.useCallback(() => {
		const mine = generation.current;
		const next = cursor.current;
		if (!next) return;
		cursor.current = null;
		setState((current) => (current.status === "ready" ? { ...current, loadingMore: true } : current));
		fetchComposioToolkits(latest.current.apiFetch, { search: query, category, cursor: next, limit: PAGE }).then(
			(page) => {
				if (mine !== generation.current) return;
				cursor.current = page.nextCursor;
				setState((current) => (current.status === "ready" ? { status: "ready", items: mergeToolkits(current.items, page.items), hasMore: page.nextCursor !== null, loadingMore: false } : current));
				setLogos((current) => withLogos(current, page.items));
			},
			() => {
				if (mine !== generation.current) return;
				// Falhou a página seguinte: mantém o que já há e deixa tentar de novo.
				cursor.current = next;
				setState((current) => (current.status === "ready" ? { ...current, loadingMore: false } : current));
			},
		);
	}, [query, category]);

	const retry = React.useCallback(() => setAttempt((value) => value + 1), []);
	return { state, loadMore, retry, logos };
}

function withLogos(current: ReadonlyMap<string, string | null>, items: readonly ComposioToolkit[]): ReadonlyMap<string, string | null> {
	const next = new Map(current);
	for (const item of items) next.set(item.slug, item.logo);
	return next;
}
