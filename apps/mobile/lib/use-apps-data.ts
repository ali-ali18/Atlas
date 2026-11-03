import * as React from "react";
import { appsErrorText, fetchComposioCategories, fetchComposioConfigured, fetchComposioConnections, fetchComposioToolkits, fetchMcpCatalog, fetchMcpConnections } from "./apps-api";
import type { ComposioCategory, ComposioConnection, ComposioToolkit, McpConnection, NativeConnector } from "./apps-parse";
import { type ComposioState, mergeToolkits } from "./apps";
import { useAtlasSession } from "./atlas-session";
import { fetchCatalog } from "./catalog-api";
import type { CatalogBot } from "./catalog";
import { isUnauthorized } from "./chat-api";
import { withTimeout } from "./with-timeout";

export type AppsData = {
	status: "loading" | "ready" | "error";
	error: string | null;
	entries: NativeConnector[];
	connections: McpConnection[];
	/** Ainda lendo o estado do Composio (status, conexões, categorias): a tela já aparece, a seção de apps espera. */
	composioLoading: boolean;
	composioConfigured: boolean;
	/** Não deu para ler o estado do Composio (status ou conexões): erro, não "desligado" nem lista vazia. */
	composioFailed: boolean;
	composioConnections: ComposioConnection[];
	composioCategories: ComposioCategory[];
	/** `null` = o catálogo de bots ainda não chegou ou não carregou (a seção aparece quando chegar). */
	bots: CatalogBot[] | null;
};

const EMPTY: AppsData = { status: "loading", error: null, entries: [], connections: [], composioLoading: true, composioConfigured: false, composioFailed: false, composioConnections: [], composioCategories: [], bots: null };

/** Limite de cada pedido: uma parte lenta (Composio, catálogo remoto de bots) não prende a tela girando. */
export const APPS_REQUEST_TIMEOUT_MS = 15_000;
const timeoutError = () => new Error("Tempo esgotado.");

/**
 * Tudo o que a tela de aplicativos e o detalhe leem, em três partes independentes que aparecem conforme chegam:
 * (1) catálogo nativo + conexões, o único obrigatório (libera a tela); (2) estado do Composio; (3) bots do catálogo.
 * Antes a tela só aparecia quando as três terminavam, e o Composio ou o catálogo remoto lentos a deixavam girando.
 * Cada pedido tem limite de tempo. `reload()` relê em silêncio (sem voltar ao "carregando").
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

	// Releituras podem se cruzar (abrir + foco): só a mais recente grava, a resposta velha é descartada.
	const generation = React.useRef(0);
	const reload = React.useCallback(async () => {
		const mine = ++generation.current;
		const { apiFetch: fetcher } = latest.current;
		const timed = <T,>(promise: Promise<T>) => withTimeout(promise, APPS_REQUEST_TIMEOUT_MS, timeoutError);
		const current = () => mounted.current && mine === generation.current;
		const merge = (patch: Partial<AppsData>) => {
			if (current()) setData((previous) => ({ ...previous, ...patch }));
		};
		const unauthorized = (reason: unknown) => {
			if (!isUnauthorized(reason)) return false;
			void latest.current.signOut();
			return true;
		};
		const soft = <T,>(promise: Promise<T>, fallback: T): Promise<T> =>
			promise.catch((reason) => {
				if (isUnauthorized(reason)) throw reason;
				return fallback;
			});

		// (2) Composio: não segura a tela. Sem saber o que já está conectado, melhor erro do que "Conectar" em dobro.
		const composio = (async () => {
			try {
				const configured = await timed(fetchComposioConfigured(fetcher));
				if (!configured) {
					merge({ composioLoading: false, composioConfigured: false, composioFailed: false, composioConnections: [], composioCategories: [] });
					return;
				}
				const [connections, categories] = await Promise.all([
					timed(fetchComposioConnections(fetcher)).then(
						(list) => list as ComposioConnection[] | null,
						(reason) => {
							if (isUnauthorized(reason)) throw reason;
							return null;
						},
					),
					// Categorias só enfeitam os chips: falhar não é erro.
					soft(timed(fetchComposioCategories(fetcher)), [] as ComposioCategory[]),
				]);
				merge({ composioLoading: false, composioConfigured: true, composioFailed: connections === null, composioConnections: connections ?? [], composioCategories: categories });
			} catch (reason) {
				if (unauthorized(reason)) return;
				merge({ composioLoading: false, composioConfigured: false, composioFailed: true });
			}
		})();

		// (3) Bots do catálogo: aparecem quando chegarem; falha só esconde a seção.
		const bots = soft(timed(fetchCatalog(fetcher)), null).then(
			(list) => merge({ bots: list }),
			(reason) => void unauthorized(reason),
		);

		// (1) Nativos + conexões: liberam a tela.
		try {
			const [entries, connections] = await Promise.all([timed(fetchMcpCatalog(fetcher)), soft(timed(fetchMcpConnections(fetcher)), [] as McpConnection[])]);
			merge({ status: "ready", error: null, entries, connections });
		} catch (reason) {
			if (!unauthorized(reason) && current()) {
				// Já havia dados: a falha de uma releitura não derruba a tela.
				setData((previous) => (previous.status === "ready" ? previous : { ...previous, status: "error", error: appsErrorText(reason, "list") }));
			}
		}
		await Promise.all([composio, bots]);
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
 * servidor) fica `off`. O "Conectado" não vem desta lista (pode estar velha): `buildAppsRows` usa as conexões do dono.
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
		withTimeout(fetchComposioToolkits(latest.current.apiFetch, { search: query, category, limit: PAGE }), APPS_REQUEST_TIMEOUT_MS, timeoutError).then(
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
		withTimeout(fetchComposioToolkits(latest.current.apiFetch, { search: query, category, cursor: next, limit: PAGE }), APPS_REQUEST_TIMEOUT_MS, timeoutError).then(
			(page) => {
				if (mine !== generation.current) return;
				cursor.current = page.nextCursor;
				setState((current) => (current.status === "ready" ? { status: "ready", items: mergeToolkits(current.items, page.items), hasMore: page.nextCursor !== null, loadingMore: false } : current));
				setLogos((current) => withLogos(current, page.items));
			},
			(reason) => {
				if (mine !== generation.current) return;
				if (isUnauthorized(reason)) void latest.current.signOut();
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
