// Search e FileStore falsos para teste (sem rede, sem disco). Exportados pelo pacote para o worker e os evals.
import { AGENDA_MAX_ACTIVE_PER_OWNER, DEFAULT_PROACTIVE_SETTINGS, findDuplicateAgendaItem, type AgendaPlan, type ChartSpec, type CreateFileInput, type PageSpec, type ProactiveSettings } from "@workspace/shared";
import type { Agenda, AgendaAction, AgendaCreateResult, AgendaItemView, AgendaRunResult } from "../ports/agenda.js";
import type { ChartStore, DeliverablePorts, DeliverableFiles, FileInspection, InspectPage, PageStore } from "../ports/deliverables.js";
import type { Helpers, HelperResult, HelperTask } from "../ports/helpers.js";
import type { FileStore, StoredFile } from "../ports/file-store.js";
import type { Memory, MemoryAddInput, MemoryItem, MemoryLayer } from "../ports/memory.js";
import type { Notebook, NotebookAddInput, NotebookNote, NotebookPatch } from "../ports/notebook.js";
import { findDuplicateNote, rankNotes } from "@workspace/shared";
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
	/** Chamadas de `inspect` (a parte pedida), para conferir o que a tool repassa. */
	readonly inspected: Array<{ userId: string; fileId: string; page?: InspectPage }> = [];

	readonly files: DeliverableFiles = {
		create: async (userId, runId, input) => {
			const id = `df-${this.created.length + 1}`;
			this.created.push({ userId, runId, input, id });
			return { id, name: input.filename, bytes: 1024, url: `https://files.test/${id}`, version: 1 };
		},
		inspect: async (userId, fileId, page) => {
			this.inspected.push({ userId, fileId, ...(page && { page }) });
			return this.inspectable.get(`${userId}:${fileId}`) ?? null;
		},
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

/** Caderno do dono em memória, por dono; aplica a mesma regra de duplicata do banco (igualdade normalizada, no mesmo escopo). */
export class FakeNotebook implements Notebook {
	readonly notes: Array<NotebookNote & { userId: string }> = [];
	private seq = 0;
	constructor(private readonly now: () => Date = () => new Date("2026-11-06T12:00:00Z")) {}
	private strip({ userId: _owner, ...note }: NotebookNote & { userId: string }): NotebookNote {
		return { ...note };
	}
	private own(userId: string, id: string) {
		return this.notes.find((note) => note.userId === userId && note.id === id);
	}
	async add(userId: string, input: NotebookAddInput): Promise<NotebookNote> {
		const scope = (note: { layer: MemoryLayer }) => note.layer;
		const same = this.notes.filter((note) => note.userId === userId && scope(note) === input.layer).map((note) => ({ id: note.id, body: note.body, botId: note.layer }));
		const dup = findDuplicateNote(same, { body: input.body, botId: input.layer });
		if (dup) throw new Error(`A note with the same text already exists: [${dup.id}].`);
		const note = { userId, id: `note-${++this.seq}`, layer: input.layer, title: input.title, body: input.body, pinned: input.pinned === true, updatedAt: this.now() };
		this.notes.push(note);
		return this.strip(note);
	}
	async search(userId: string, query: string, limit?: number): Promise<NotebookNote[]> {
		const mine = this.notes.filter((note) => note.userId === userId);
		const ranked = rankNotes(mine, query, limit);
		return ranked.map((note) => this.strip(note));
	}
	async get(userId: string, id: string): Promise<NotebookNote | null> {
		const note = this.own(userId, id);
		return note ? this.strip(note) : null;
	}
	async update(userId: string, id: string, patch: NotebookPatch): Promise<NotebookNote | null> {
		const note = this.own(userId, id);
		if (!note) return null;
		if (patch.title !== undefined) note.title = patch.title;
		if (patch.body !== undefined) note.body = patch.body;
		note.updatedAt = this.now();
		return this.strip(note);
	}
	async pin(userId: string, id: string, pinned: boolean): Promise<NotebookNote | null> {
		const note = this.own(userId, id);
		if (!note) return null;
		note.pinned = pinned;
		return this.strip(note);
	}
	async remove(userId: string, id: string): Promise<boolean> {
		const index = this.notes.findIndex((note) => note.userId === userId && note.id === id);
		if (index < 0) return false;
		this.notes.splice(index, 1);
		return true;
	}
	async listPinned(userId: string): Promise<Array<Pick<NotebookNote, "id" | "title">>> {
		return this.notes.filter((note) => note.userId === userId && note.pinned).map(({ id, title }) => ({ id, title }));
	}
}

const DEFAULT_SETTINGS: BotSettingsView = { name: "Atlas", snippet: "", description: "", language: "pt-BR", notify: true, roleModels: {} };

/** Configurações do bot por dono, em memória. */
export class FakeSettings implements Settings {
	readonly views = new Map<string, BotSettingsView>();
	readonly updates: Array<{ userId: string; patch: BotSettingsPatch }> = [];
	readonly availableModels?: () => Promise<readonly string[]>;
	readonly supportsRoleModels: boolean;
	constructor(models?: readonly string[], options: { supportsRoleModels?: boolean } = {}) {
		if (models) this.availableModels = async () => models;
		this.supportsRoleModels = options.supportsRoleModels ?? true;
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

/**
 * Ajudantes falsos: cada tarefa responde por `respond(task, index)` (padrão: um resultado `done` com uma fonte).
 * Registra as chamadas e o instante de início/fim de cada tarefa, para provar o paralelismo sem relógio real.
 */
export class FakeHelpers implements Helpers {
	readonly calls: Array<{ tasks: readonly HelperTask[] }> = [];
	/** Quantas tarefas estavam em andamento ao mesmo tempo, no máximo. */
	maxConcurrent = 0;
	private running = 0;
	constructor(private readonly respond: (task: HelperTask, index: number) => HelperResult | Promise<HelperResult> = (task) => ({ status: "done", text: `Resposta: ${task.objective}`, sources: [{ url: `https://example.test/${encodeURIComponent(task.objective)}`, title: "Fonte de teste" }], spentUsd: 0, untrustedRead: true })) {}
	async runAll(tasks: readonly HelperTask[]): Promise<HelperResult[]> {
		this.calls.push({ tasks });
		return Promise.all(
			tasks.map(async (task, index) => {
				this.running++;
				this.maxConcurrent = Math.max(this.maxConcurrent, this.running);
				try {
					await Promise.resolve();
					return await this.respond(task, index);
				} finally {
					this.running--;
				}
			}),
		);
	}
}

/**
 * Agenda falsa em memória: mesmas regras de dono, dedupe e limite do adaptador real (sem relógio nem fila). `startRun`
 * liga um item a um run de agenda (o que a varredura do worker faz) para `reportResult` ter onde gravar.
 */
export class FakeAgenda implements Agenda {
	readonly items = new Map<string, AgendaItemView & { userId: string; runId?: string; noteUntrusted?: boolean }>();
	readonly results: Array<{ userId: string; runId: string; result: AgendaRunResult; untrustedRead: boolean }> = [];
	private seq = 0;
	constructor(private readonly settingsValue: ProactiveSettings = { ...DEFAULT_PROACTIVE_SETTINGS, enabled: true }) {}

	async settings(): Promise<ProactiveSettings> {
		return this.settingsValue;
	}
	private view(item: AgendaItemView & { userId: string; noteUntrusted?: boolean }): AgendaItemView {
		const { userId: _userId, noteUntrusted: _noteUntrusted, ...view } = structuredClone(item);
		void _userId;
		void _noteUntrusted;
		return view;
	}
	async create(userId: string, plan: AgendaPlan, context?: { sourceRunId: string; untrustedRead?: boolean }): Promise<AgendaCreateResult> {
		const active = [...this.items.values()].filter((i) => i.userId === userId && (i.status === "pending" || i.status === "paused"));
		const found = findDuplicateAgendaItem(active.map((i) => ({ ...i, dueAt: new Date(i.nextRunAt), intervalMinutes: i.everyMinutes })), plan);
		const same = found ? this.items.get(found.id) : undefined;
		if (same) return { ok: true, item: this.view(same), duplicate: true };
		if (active.length >= AGENDA_MAX_ACTIVE_PER_OWNER) return { ok: false, error: `There are already ${AGENDA_MAX_ACTIVE_PER_OWNER} active agenda items. Cancel or finish one before adding another.` };
		const id = `ag-${++this.seq}`;
		const item = {
			id,
			userId,
			kind: plan.kind,
			status: "pending" as const,
			note: plan.note,
			nextRunAt: plan.dueAt.toISOString(),
			everyMinutes: plan.intervalMinutes,
			untilAt: plan.untilAt?.toISOString() ?? null,
			runCount: 0,
			maxRuns: plan.maxRuns,
			eventFilter: plan.eventFilter,
			endReason: null,
			noteUntrusted: context?.untrustedRead === true,
		};
		this.items.set(id, item);
		return { ok: true, item: this.view(item), duplicate: false };
	}
	async list(userId: string, options: { includeEnded?: boolean } = {}): Promise<AgendaItemView[]> {
		return [...this.items.values()].filter((i) => i.userId === userId && (options.includeEnded || i.status === "pending" || i.status === "paused")).map((i) => this.view(i));
	}
	async change(userId: string, id: string, action: AgendaAction): Promise<AgendaItemView | null> {
		const item = this.items.get(id);
		if (!item || item.userId !== userId) return null;
		const allowed = action === "pause" ? ["pending"] : action === "resume" ? ["paused"] : ["pending", "paused"];
		if (!allowed.includes(item.status)) return null;
		item.status = action === "pause" ? "paused" : action === "resume" ? "pending" : "cancelled";
		if (action === "cancel") item.endReason = "owner";
		return this.view(item);
	}
	/** Liga o item ao run que o está executando (como a varredura do worker faz ao acordá-lo). */
	startRun(userId: string, id: string, runId: string): void {
		const item = this.items.get(id);
		if (!item || item.userId !== userId) throw new Error(`FakeAgenda: item ${id} is not ${userId}'s`);
		item.runId = runId;
		item.runCount += 1;
	}
	async reportResult(userId: string, runId: string, result: AgendaRunResult, context?: { untrustedRead?: boolean }): Promise<{ ok: true } | { ok: false; error: string }> {
		const item = [...this.items.values()].find((i) => i.userId === userId && i.runId === runId);
		if (!item) return { ok: false, error: "No agenda item is attached to this run." };
		if (this.results.some((r) => r.userId === userId && r.runId === runId)) return { ok: true };
		this.results.push({ userId, runId, result: structuredClone(result), untrustedRead: context?.untrustedRead === true });
		if (result.outcome === "done") {
			item.status = "done";
			item.endReason = "done";
		}
		return { ok: true };
	}
}
