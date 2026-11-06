// Porta `Search`: busca e leitura de páginas da web. O adaptador real é `adapters/web.ts` (F2.1); o motor só conhece
// esta forma mínima. Escopada pelo dono, como o resto das portas. `SearchPort` e `ExtractPort` são as metades, para
// quem só usa uma. Falha da porta = `throw` com a mensagem real (a tool a devolve como `ok:false`).

export type SearchHit = { title: string; url: string; snippet: string };

export type SearchExtract = { url: string; title?: string; text: string };

export interface SearchPort {
	search(userId: string, query: string, options?: { limit?: number }, signal?: AbortSignal): Promise<SearchHit[]>;
}

export interface ExtractPort {
	/** Devolve a página INTEIRA (o kernel pagina o que for grande); só o limite técnico da leitura corta, e avisa. */
	extract(userId: string, url: string, signal?: AbortSignal): Promise<SearchExtract>;
}

export interface Search extends SearchPort, ExtractPort {}
