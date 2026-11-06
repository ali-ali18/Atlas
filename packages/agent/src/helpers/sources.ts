// Fontes do ajudante: as páginas que ele LEU de verdade. Em vez de confiar no modelo para citar, a porta `Search` do filho
// é embrulhada e cada `extract` bem-sucedido vira uma fonte (url final da página, título). Resultado de busca (só
// título e trecho) não conta como leitura: a mãe cita por afirmação o que foi lido, não o que apareceu numa lista.
import type { HelperSource } from "../ports/helpers.js";
import type { Search } from "../ports/search.js";

export type SourceRecorder = { search: Search; sources(): HelperSource[] };

/** Páginas já lidas (ou em leitura) dentro de UM `runAll`, por URL pedida. Compartilhado pelos ajudantes do mesmo lote (mesmo dono). */
export type ExtractCache = Map<string, ReturnType<Search["extract"]>>;

export function recordSources(search: Search, cache?: ExtractCache): SourceRecorder {
	const seen = new Map<string, HelperSource>();
	return {
		search: {
			search: (userId, query, options, signal) => search.search(userId, query, options, signal),
			async extract(userId, url, signal) {
				const page = await extractOnce(search, cache, userId, url, signal);
				if (!seen.has(page.url)) seen.set(page.url, { url: page.url, ...(page.title && { title: page.title }) });
				return page;
			},
		},
		sources: () => [...seen.values()],
	};
}

/** Uma leitura por URL no lote: quem chega depois espera a mesma leitura. Falha não fica no cache. Nada é cortado. */
function extractOnce(search: Search, cache: ExtractCache | undefined, userId: string, url: string, signal: AbortSignal | undefined): ReturnType<Search["extract"]> {
	if (!cache) return search.extract(userId, url, signal);
	const hit = cache.get(url);
	// Quem chega depois divide a leitura; se ela falhou, lê por conta própria (a falha de outro ajudante não vira a sua).
	if (hit) return hit.catch(() => search.extract(userId, url, signal));
	const pending = search.extract(userId, url, signal);
	cache.set(url, pending);
	pending.catch(() => {
		if (cache.get(url) === pending) cache.delete(url);
	});
	return pending;
}
