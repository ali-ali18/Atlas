// Porta `Search`: busca e leitura de páginas da web. A implementação real (provedor de busca, SSRF, limites)
// vem na F2; o motor só conhece esta forma mínima. Escopada pelo dono, como o resto das portas.

export type SearchHit = { title: string; url: string; snippet: string };

export type SearchExtract = { url: string; title?: string; text: string };

export interface Search {
	search(userId: string, query: string, options?: { limit?: number }, signal?: AbortSignal): Promise<SearchHit[]>;
	extract(userId: string, url: string, signal?: AbortSignal): Promise<SearchExtract>;
}
