import * as React from "react";
import { log, timedStage } from "./apps-diagnostics";
import { appsErrorText, fetchComposioCategories, fetchComposioConfigured, fetchComposioConnections, fetchComposioToolkits, fetchMcpCatalog, fetchMcpConnections } from "./apps-api";
import type { ComposioCategory, ComposioConnection, ComposioToolkit, McpConnection, NativeConnector } from "./apps-parse";
import { type ComposioState } from "./apps";
import { applyPage, canLoadMore, clampPage, EMPTY_PAGING, failMore, type Paging, startMore } from "./composio-paging";
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

const EMPTY: AppsData = {
	status: "loading",
	error: null,
	entries: [],
	connections: [],
	composioLoading: true,
	composioConfigured: false,
	composioFailed: false,
	composioConnections: [],
	composioCategories: [],
	bots: null,
};

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
		log("reload:início", { geracao: mine });
		const { apiFetch: fetcher } = latest.current;
		const timed = <T>(promise: Promise<T>) => withTimeout(promise, APPS_REQUEST_TIMEOUT_MS, timeoutError);
		const current = () => mounted.current && mine === generation.current;
		const merge = (patch: Partial<AppsData>) => {
			log("reload:merge", {
				campos: Object.keys(patch).join(","),
				atual: current() ? 1 : 0,
			});
			if (current()) setData((previous) => ({ ...previous, ...patch }));
		};
		const unauthorized = (reason: unknown) => {
			if (!isUnauthorized(reason)) return false;
			void latest.current.signOut();
			return true;
		};
		const soft = <T>(promise: Promise<T>, fallback: T): Promise<T> =>
			promise.catch((reason) => {
				if (isUnauthorized(reason)) throw reason;
				return fallback;
			});

		// (2) Composio: não segura a tela. Sem saber o que já está conectado, melhor erro do que "Conectar" em dobro.
		const composio = (async () => {
			try {
				const configured = await timed(
					timedStage(
						"composio-status",
						() => fetchComposioConfigured(fetcher),
						(value) => ({ configurado: value ? 1 : 0 }),
					),
				);
				if (!configured) {
					merge({
						composioLoading: false,
						composioConfigured: false,
						composioFailed: false,
						composioConnections: [],
						composioCategories: [],
					});
					return;
				}
				const [connections, categories] = await Promise.all([
					timed(
						timedStage(
							"composio-conexões",
							() => fetchComposioConnections(fetcher),
							(list) => ({ conexões: list.length }),
						),
					).then(
						(list) => list as ComposioConnection[] | null,
						(reason) => {
							if (isUnauthorized(reason)) throw reason;
							return null;
						},
					),
					// Categorias só enfeitam os chips: falhar não é erro.
					soft(
						timed(
							timedStage(
								"composio-categorias",
								() => fetchComposioCategories(fetcher),
								(list) => ({ categorias: list.length }),
							),
						),
						[] as ComposioCategory[],
					),
				]);
				merge({
					composioLoading: false,
					composioConfigured: true,
					composioFailed: connections === null,
					composioConnections: connections ?? [],
					composioCategories: categories,
				});
			} catch (reason) {
				if (unauthorized(reason)) return;
				merge({
					composioLoading: false,
					composioConfigured: false,
					composioFailed: true,
				});
			}
		})();

		// (3) Bots do catálogo: aparecem quando chegarem; falha só esconde a seção.
		const bots = soft(
			timed(
				timedStage(
					"bots-catálogo",
					() => fetchCatalog(fetcher),
					(list) => ({ bots: list.length }),
				),
			),
			null,
		).then(
			(list) => merge({ bots: list }),
			(reason) => void unauthorized(reason),
		);

		// (1) Nativos + conexões: liberam a tela.
		try {
			const [entries, connections] = await Promise.all([
				timed(
					timedStage(
						"nativos-catálogo",
						() => fetchMcpCatalog(fetcher),
						(list) => ({ itens: list.length }),
					),
				),
				soft(
					timed(
						timedStage(
							"nativos-conexões",
							() => fetchMcpConnections(fetcher),
							(list) => ({ conexões: list.length }),
						),
					),
					[] as McpConnection[],
				),
			]);
			merge({ status: "ready", error: null, entries, connections });
		} catch (reason) {
			if (!unauthorized(reason) && current()) {
				// Já havia dados: a falha de uma releitura não derruba a tela.
				setData((previous) =>
					previous.status === "ready"
						? previous
						: {
								...previous,
								status: "error",
								error: appsErrorText(reason, "list"),
							},
				);
			}
		}
		log("reload:nativos-prontos");
		await Promise.all([composio, bots]);
		log("reload:fim");
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
 * A paginação (um pedido por vez, fim por cursor repetido/página sem novidade, teto) é `lib/composio-paging.ts`.
 */
export function useComposioList(options: { enabled: boolean; query: string; category: string | null }): {
	state: ComposioState;
	loadMore: () => void;
	retry: () => void;
	logos: ReadonlyMap<string, string | null>;
} {
	const { apiFetch, signOut } = useAtlasSession();
	const { enabled, query, category } = options;
	const [state, setState] = React.useState<ComposioState>({ status: "loading" });
	const [attempt, setAttempt] = React.useState(0);
	const [logos, setLogos] = React.useState<ReadonlyMap<string, string | null>>(new Map());
	// Fonte da verdade da paginação (síncrona: o guarda de "em voo" não pode esperar o re-render).
	const paging = React.useRef<Paging>(EMPTY_PAGING);
	const generation = React.useRef(0);
	const latest = React.useRef({ apiFetch, signOut });
	latest.current = { apiFetch, signOut };
	const request = React.useRef({ query, category });
	request.current = { query, category };

	const publish = React.useCallback((next: Paging) => {
		log("publish", {
			itens: next.items.length,
			paginas: next.pages,
			cursor: next.cursor ? next.cursor.length : 0,
			fim: next.done ? 1 : 0,
			carregando: next.loading ? 1 : 0,
		});
		paging.current = next;
		setState({
			status: "ready",
			items: next.items,
			hasMore: !next.done && next.cursor !== null,
			loadingMore: next.loading,
		});
	}, []);

	React.useEffect(() => {
		const mine = ++generation.current;
		paging.current = EMPTY_PAGING;
		if (!enabled) {
			setState({ status: "off" });
			return;
		}
		setState({ status: "loading" });
		log("toolkits:1ª página", {
			busca: query.length,
			categoria: category ? 1 : 0,
			tentativa: attempt,
		});
		withTimeout(
			fetchComposioToolkits(latest.current.apiFetch, {
				search: query,
				category,
				limit: PAGE,
			}),
			APPS_REQUEST_TIMEOUT_MS,
			timeoutError,
		).then(
			(page) => {
				if (mine !== generation.current) {
					log("toolkits:1ª descartada", { geracao: mine });
					return;
				}
				const from = Date.now();
				const applied = applyPage(EMPTY_PAGING, page, null);
				log("applyPage", {
					itens: applied.items.length,
					dur: Date.now() - from,
				});
				publish(applied);
				const logosFrom = Date.now();
				setLogos((current) => withLogos(current, clampPage(page).items));
				log("setLogos", { dur: Date.now() - logosFrom });
			},
			(reason) => {
				if (mine !== generation.current) return;
				log("toolkits:1ª falhou", {
					status: (reason as { status?: number } | null)?.status ?? 0,
					erro: reason instanceof Error ? reason.message : "?",
				});
				if (isUnauthorized(reason)) void latest.current.signOut();
				setState(reason && (reason as { status?: number }).status === 409 ? { status: "off" } : { status: "error" });
			},
		);
	}, [enabled, query, category, attempt, publish]);

	const loadMore = React.useCallback(() => {
		const mine = generation.current;
		const before = paging.current;
		if (!canLoadMore(before)) return;
		const requested = before.cursor;
		log("toolkits:mais", { paginas: before.pages, itens: before.items.length });
		publish(startMore(before));
		withTimeout(
			fetchComposioToolkits(latest.current.apiFetch, {
				search: request.current.query,
				category: request.current.category,
				cursor: requested,
				limit: PAGE,
			}),
			APPS_REQUEST_TIMEOUT_MS,
			timeoutError,
		).then(
			(page) => {
				if (mine !== generation.current) return;
				const from = Date.now();
				const applied = applyPage(paging.current, page, requested);
				log("applyPage:mais", {
					itens: applied.items.length,
					dur: Date.now() - from,
				});
				publish(applied);
				setLogos((current) => withLogos(current, clampPage(page).items));
				log("setLogos:mais");
			},
			(reason) => {
				if (mine !== generation.current) return;
				if (isUnauthorized(reason)) void latest.current.signOut();
				log("toolkits:mais falhou", {
					erro: reason instanceof Error ? reason.message : "?",
				});
				// Falhou a página seguinte: mantém o que já há e deixa tentar de novo.
				publish(failMore(paging.current));
			},
		);
	}, [publish]);

	const retry = React.useCallback(() => setAttempt((value) => value + 1), []);
	return { state, loadMore, retry, logos };
}

function withLogos(current: ReadonlyMap<string, string | null>, items: readonly ComposioToolkit[]): ReadonlyMap<string, string | null> {
	const next = new Map(current);
	for (const item of items) next.set(item.slug, item.logo);
	return next;
}
