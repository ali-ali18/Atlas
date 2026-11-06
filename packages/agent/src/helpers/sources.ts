// Fontes do ajudante: as páginas que ele LEU de verdade. Em vez de confiar no modelo para citar, a porta `Search` do filho
// é embrulhada e cada `extract` bem-sucedido vira uma fonte (url final da página, título). Resultado de busca (só
// título e trecho) não conta como leitura: a mãe cita por afirmação o que foi lido, não o que apareceu numa lista.
import type { HelperSource } from "../ports/helpers.js";
import type { Search } from "../ports/search.js";

export type SourceRecorder = { search: Search; sources(): HelperSource[] };

export function recordSources(search: Search): SourceRecorder {
	const seen = new Map<string, HelperSource>();
	return {
		search: {
			search: (userId, query, options, signal) => search.search(userId, query, options, signal),
			async extract(userId, url, signal) {
				const page = await search.extract(userId, url, signal);
				if (!seen.has(page.url)) seen.set(page.url, { url: page.url, ...(page.title && { title: page.title }) });
				return page;
			},
		},
		sources: () => [...seen.values()],
	};
}
