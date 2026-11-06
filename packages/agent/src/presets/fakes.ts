// Search e FileStore falsos para teste (sem rede, sem disco). Exportados pelo pacote para o worker e os evals.
import type { ChartSpec, CreateFileInput, PageSpec } from "@workspace/shared";
import type { ChartStore, DeliverablePorts, DeliverableFiles, FileInspection, PageStore } from "../ports/deliverables.js";
import type { FileStore, StoredFile } from "../ports/file-store.js";
import type { Memory, MemoryAddInput, MemoryItem, MemoryLayer } from "../ports/memory.js";
import type { Search, SearchExtract, SearchHit } from "../ports/search.js";
import type { BotSettingsPatch, BotSettingsView, Settings } from "../ports/settings.js";
import type { TaskListState, TaskListStore } from "../ports/task-list.js";

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

/** Memória em memória que filtra por dono como o adaptador real: usuário B nunca vê nem muda o que é do A. */
export class FakeMemory implements Memory {
	readonly items: Array<MemoryItem & { userId: string }> = [];
	private seq = 0;
	constructor(private readonly now: () => Date = () => new Date("2026-11-06T12:00:00Z")) {}
	async list(userId: string, layer?: MemoryLayer): Promise<MemoryItem[]> {
		return this.items.filter((item) => item.userId === userId && (layer === undefined || item.layer === layer)).map(({ userId: _owner, ...item }) => ({ ...item }));
	}
	async add(userId: string, input: MemoryAddInput): Promise<MemoryItem> {
		const item = { userId, id: `mem-${++this.seq}`, layer: input.layer, content: input.content, ...(input.category && { category: input.category }), updatedAt: this.now() };
		this.items.push(item);
		const { userId: _owner, ...visible } = item;
		return visible;
	}
	async replace(userId: string, id: string, content: string): Promise<MemoryItem | null> {
		const item = this.items.find((entry) => entry.userId === userId && entry.id === id);
		if (!item) return null;
		item.content = content;
		item.updatedAt = this.now();
		const { userId: _owner, ...visible } = item;
		return visible;
	}
	async remove(userId: string, id: string): Promise<boolean> {
		const index = this.items.findIndex((entry) => entry.userId === userId && entry.id === id);
		if (index < 0) return false;
		this.items.splice(index, 1);
		return true;
	}
}

const DEFAULT_SETTINGS: BotSettingsView = { name: "Atlas", snippet: "", description: "", language: "pt-BR", notify: true, roleModels: {} };

/** Configurações do bot por dono, em memória. */
export class FakeSettings implements Settings {
	readonly views = new Map<string, BotSettingsView>();
	readonly updates: Array<{ userId: string; patch: BotSettingsPatch }> = [];
	readonly availableModels?: () => Promise<readonly string[]>;
	constructor(models?: readonly string[]) {
		if (models) this.availableModels = async () => models;
	}
	async get(userId: string): Promise<BotSettingsView> {
		const view = this.views.get(userId) ?? DEFAULT_SETTINGS;
		return { ...view, roleModels: { ...view.roleModels } };
	}
	async update(userId: string, patch: BotSettingsPatch): Promise<BotSettingsView> {
		this.updates.push({ userId, patch });
		const current = await this.get(userId);
		const roleModels = { ...current.roleModels };
		for (const [role, model] of Object.entries(patch.roleModels ?? {})) {
			if (model === null) delete roleModels[role as keyof typeof roleModels];
			else if (model !== undefined) roleModels[role as keyof typeof roleModels] = model;
		}
		const next: BotSettingsView = { ...current, ...patch.profile, ...(patch.language !== undefined && { language: patch.language }), ...(patch.notify !== undefined && { notify: patch.notify }), roleModels };
		this.views.set(userId, next);
		return next;
	}
}

/** Lista de tarefas por (dono, run), em memória. */
export class FakeTaskListStore implements TaskListStore {
	readonly states = new Map<string, TaskListState>();
	async get(userId: string, runId: string): Promise<TaskListState | null> {
		const state = this.states.get(`${userId}:${runId}`);
		return state ? structuredClone(state) : null;
	}
	async set(userId: string, runId: string, state: TaskListState): Promise<void> {
		this.states.set(`${userId}:${runId}`, structuredClone(state));
	}
}
