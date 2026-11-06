// Porta `Search` do v4 no worker (F2.6): o pacote `@workspace/agent` não importa `@workspace/search`; quem importa é o
// worker, que injeta a busca (SearXNG) e a extração de página no adaptador real.
import { createWebAdapter, type ExtractPageFn, type Search, type SearxngSearchFn } from "@workspace/agent";
import { extractWebPage, resolveSearxngBaseUrl, searchSearxng } from "@workspace/search";

export type V4WebDeps = {
	extract: ExtractPageFn;
	/** Ausente = sem SearXNG configurado: a busca vai direto ao DuckDuckGo. */
	searxng?: SearxngSearchFn;
};

/** Dependências reais: SearXNG só entra quando há `SEARXNG_URL` (ou equivalente) no ambiente. */
export function realV4WebDeps(env: NodeJS.ProcessEnv = process.env): V4WebDeps {
	const hasSearxng = Boolean(resolveSearxngBaseUrl(env));
	return {
		extract: (url, options) => extractWebPage(url, options),
		...(hasSearxng && {
			searxng: async (query, options) => (await searchSearxng(query, { env, ...(options.num !== undefined && { num: options.num }), ...(options.signal && { signal: options.signal }) })).map((hit) => ({ url: hit.url, title: hit.title, snippet: hit.snippet })),
		}),
	};
}

export function createV4Search(deps: V4WebDeps = realV4WebDeps()): Search {
	return createWebAdapter({ extract: deps.extract, ...(deps.searxng && { searxng: deps.searxng }) });
}
