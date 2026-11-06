// Search e FileStore falsos para teste (sem rede, sem disco). Exportados pelo pacote para o worker e os evals.
import type { FileStore, StoredFile } from "../ports/file-store.js";
import type { Search, SearchExtract, SearchHit } from "../ports/search.js";

export class FakeSearch implements Search {
	readonly queries: Array<{ userId: string; query: string }> = [];
	readonly extracted: Array<{ userId: string; url: string }> = [];
	constructor(private readonly hits: SearchHit[] = [{ title: "Resultado de teste", url: "https://example.test/resultado", snippet: "Trecho de teste." }]) {}
	async search(userId: string, query: string): Promise<SearchHit[]> {
		this.queries.push({ userId, query });
		return this.hits;
	}
	async extract(userId: string, url: string): Promise<SearchExtract> {
		this.extracted.push({ userId, url });
		return { url, title: "Página de teste", text: "Conteúdo da página de teste." };
	}
}

export class FakeFileStore implements FileStore {
	readonly files: Array<{ userId: string; name: string; mimeType: string; content: string; id: string }> = [];
	async put(userId: string, file: { name: string; mimeType: string; content: string }): Promise<StoredFile> {
		const id = `file-${this.files.length + 1}`;
		this.files.push({ userId, ...file, id });
		return { id, name: file.name, bytes: Buffer.byteLength(file.content), url: `https://files.test/${id}` };
	}
}
