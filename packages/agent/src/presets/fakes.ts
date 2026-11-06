// Search e FileStore falsos para teste (sem rede, sem disco). Exportados pelo pacote para o worker e os evals.
import type { ChartSpec, CreateFileInput, PageSpec } from "@workspace/shared";
import type { ChartStore, DeliverablePorts, DeliverableFiles, FileInspection, PageStore } from "../ports/deliverables.js";
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

export class FakeDeliverables {
	readonly created: Array<{ userId: string; runId: string; input: CreateFileInput; id: string }> = [];
	readonly pages: Array<{ userId: string; runId: string; spec: PageSpec; id: string }> = [];
	readonly charts: Array<{ userId: string; runId: string; spec: ChartSpec; id: string }> = [];
	/** Arquivos inspecionáveis: chave `userId:fileId`. */
	readonly inspectable = new Map<string, FileInspection>();

	readonly files: DeliverableFiles = {
		create: async (userId, runId, input) => {
			const id = `df-${this.created.length + 1}`;
			this.created.push({ userId, runId, input, id });
			return { id, name: input.filename, bytes: 1024, url: `https://files.test/${id}`, version: 1 };
		},
		inspect: async (userId, fileId) => this.inspectable.get(`${userId}:${fileId}`) ?? null,
	};
	readonly pageStore: PageStore = {
		save: async (userId, runId, spec) => {
			const id = `page-${this.pages.length + 1}`;
			this.pages.push({ userId, runId, spec, id });
			return { id, title: spec.title, url: `https://pages.test/${id}` };
		},
	};
	readonly chartStore: ChartStore = {
		save: async (userId, runId, spec) => {
			const id = `chart-${this.charts.length + 1}`;
			this.charts.push({ userId, runId, spec, id });
			return { id };
		},
	};
	/** Forma que a capacidade recebe. */
	ports(): DeliverablePorts {
		return { files: this.files, pages: this.pageStore, charts: this.chartStore };
	}
}
