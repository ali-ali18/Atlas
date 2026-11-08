// Search e FileStore falsos para teste (sem rede, sem disco). Exportados pelo pacote para o worker e os evals.
import { AGENDA_MAX_ACTIVE_PER_OWNER, DEFAULT_PROACTIVE_SETTINGS, findDuplicateAgendaItem, type AgendaPlan, type ChartSpec, type CreateFileInput, type PageSpec, type ProactiveSettings } from "@workspace/shared";
import type { Agenda, AgendaAction, AgendaCreateResult, AgendaItemView, AgendaRunResult } from "../ports/agenda.js";
import type { ChartStore, DeliverablePorts, DeliverableFiles, FileInspection, InspectPage, PageStore } from "../ports/deliverables.js";
import type { Helpers, HelperResult, HelperTask } from "../ports/helpers.js";
import type { FileStore, StoredFile } from "../ports/file-store.js";
import type { Memory, MemoryAddInput, MemoryItem, MemoryLayer } from "../ports/memory.js";
import type { Notebook, NotebookAddInput, NotebookNote, NotebookPatch } from "../ports/notebook.js";
import { findDuplicateNote, purchaseDedupeKey, purchaseMergePatch, rankNotes, type CalendarEventView, type PurchaseView } from "@workspace/shared";
import type { CalendarCardPayload, CalendarPorts } from "../ports/calendar.js";
import type { ProductCardPayload, ShoppingPorts } from "../ports/shopping.js";
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
	async create(userId: string, plan: AgendaPlan, context?: { sourceRunId: string; untrustedRead?: boolean; exactIdentity?: boolean }): Promise<AgendaCreateResult> {
		const active = [...this.items.values()].filter((i) => i.userId === userId && (i.status === "pending" || i.status === "paused"));
		// Plano do dia: um por dono (o db: um por bot); criar de novo ATUALIZA o existente.
		const brief = plan.kind === "brief" ? active.find((i) => i.kind === "brief") : undefined;
		if (brief) {
			Object.assign(brief, { note: plan.note, nextRunAt: plan.dueAt.toISOString(), everyMinutes: plan.intervalMinutes, untilAt: plan.untilAt?.toISOString() ?? null, maxRuns: plan.maxRuns, status: "pending" as const, endReason: null, noteUntrusted: context?.untrustedRead === true });
			return { ok: true, item: this.view(brief), duplicate: false, updated: true };
		}
		const found = context?.exactIdentity ? undefined : findDuplicateAgendaItem(active.map((i) => ({ ...i, dueAt: new Date(i.nextRunAt), intervalMinutes: i.everyMinutes })), plan);
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

/** Página de produto de teste com JSON-LD (a forma que as lojas publicam). `shipping` ausente = frete não informado. */
export function productPageHtml(input: { name: string; price: number; currency?: string; shipping?: number; merchant?: string; availability?: string; oldPrice?: number; images?: string[]; rating?: { value: number; count: number } }): string {
	const currency = input.currency ?? "BRL";
	const offer = {
		"@type": "Offer",
		price: input.price,
		priceCurrency: currency,
		availability: `https://schema.org/${input.availability ?? "InStock"}`,
		...(input.merchant && { seller: { "@type": "Organization", name: input.merchant } }),
		...(input.shipping !== undefined && { shippingDetails: { "@type": "OfferShippingDetails", shippingRate: { "@type": "MonetaryAmount", value: input.shipping, currency } } }),
	};
	const product = { "@context": "https://schema.org", "@type": "Product", name: input.name, image: input.images ?? [], description: `Descrição de ${input.name}.`, offers: offer, ...(input.oldPrice !== undefined && { offers: { ...offer, priceSpecification: { "@type": "UnitPriceSpecification", priceType: "https://schema.org/ListPrice", price: input.oldPrice } } }), ...(input.rating && { aggregateRating: { "@type": "AggregateRating", ratingValue: input.rating.value, reviewCount: input.rating.count } }) };
	return `<html><head><title>${input.name}</title><script type="application/ld+json">${JSON.stringify(product)}</script></head><body><h1>${input.name}</h1></body></html>`;
}

/** Portas de compras falsas em memória: páginas por URL, cartões emitidos e compras com dono e dedupe (mesmas regras do db). */
export class FakeShopping {
	readonly html = new Map<string, string>();
	readonly fetched: Array<{ userId: string; url: string }> = [];
	readonly productCards: Array<{ userId: string; runId: string; card: ProductCardPayload }> = [];
	readonly purchaseCards: Array<{ userId: string; runId: string; purchase: PurchaseView }> = [];
	readonly rows: Array<PurchaseView & { userId: string; key: string; deliveryWatchId?: string }> = [];
	private seq = 0;

	readonly ports: ShoppingPorts = {
		pages: {
			fetchHtml: async (userId, url) => {
				this.fetched.push({ userId, url });
				const html = this.html.get(url);
				if (html === undefined) throw new Error("The page could not be fetched (blocked, not found or unreachable).");
				return { url, html };
			},
		},
		cards: {
			show: async (userId, runId, card) => {
				if (!this.productCards.some((c) => c.card.cardId === card.cardId)) this.productCards.push({ userId, runId, card });
			},
		},
		purchases: {
			record: async (userId, _runId, purchase, options) => {
				const key = purchaseDedupeKey(purchase, options?.timeZone);
				const found = this.rows.find((r) => r.userId === userId && r.key === key);
				if (found) {
					Object.assign(found, purchaseMergePatch(found, purchase));
					return { purchase: this.view(found), duplicate: true, deliveryWatchId: found.deliveryWatchId ?? null };
				}
				const row = { ...structuredClone(purchase), id: `pur-${++this.seq}`, botId: null, createdAt: new Date(0).toISOString(), userId, key };
				this.rows.push(row);
				return { purchase: this.view(row), duplicate: false, deliveryWatchId: null };
			},
			attachDeliveryWatch: async (userId, purchaseId, watchId) => {
				const row = this.rows.find((r) => r.userId === userId && r.id === purchaseId);
				if (row) row.deliveryWatchId = watchId;
			},
			get: async (userId, id) => {
				const row = this.rows.find((r) => r.userId === userId && r.id === id);
				return row ? { ...this.view(row), deliveryWatchId: row.deliveryWatchId ?? null } : null;
			},
			update: async (userId, id, purchase, options) => {
				const row = this.rows.find((r) => r.userId === userId && r.id === id);
				if (!row) return null;
				const key = purchaseDedupeKey(purchase, options?.timeZone);
				if (this.rows.some((r) => r !== row && r.userId === userId && r.key === key)) throw new Error("another purchase already has these details");
				for (const k of ["orderNumber", "trackingCode", "trackingUrl"] as const) delete row[k];
				Object.assign(row, structuredClone(purchase), { key });
				return this.view(row);
			},
			remove: async (userId, id) => {
				const at = this.rows.findIndex((r) => r.userId === userId && r.id === id);
				if (at < 0) return null;
				const [row] = this.rows.splice(at, 1);
				return { deliveryWatchId: row!.deliveryWatchId ?? null };
			},
			show: async (userId, runId, purchase) => {
				this.purchaseCards.push({ userId, runId, purchase });
			},
			list: async (userId, options) => this.rows.filter((r) => r.userId === userId).slice(0, options?.limit ?? 50).map((r) => this.view(r)),
		},
	};
	private view(row: PurchaseView & { userId: string; key: string; deliveryWatchId?: string }): PurchaseView {
		const { userId: _u, key: _k, deliveryWatchId: _d, ...view } = structuredClone(row);
		void _u;
		void _k;
		void _d;
		return view;
	}
}

/**
 * Agenda do Google falsa em memória (F7.1): eventos por dono, com as mesmas regras da porta real (outro dono não vê nada,
 * id desconhecido = `null`/`false`). `fail` simula o Google fora do ar ou o login expirado.
 */
export class FakeCalendar {
	readonly events: Array<CalendarEventView & { userId: string }> = [];
	readonly cards: Array<{ userId: string; runId: string; card: CalendarCardPayload }> = [];
	readonly writes: Array<{ userId: string; op: "create" | "update" | "remove"; id?: string; notifyGuests?: boolean; requestKey?: string }> = [];
	/** Erro que as próximas chamadas lançam (null = sem falha). */
	fail: Error | null = null;
	/** Erro só de `list` (a escrita segue funcionando): simula a checagem de conflito falhando. */
	failList: Error | null = null;
	timeZoneValue = "America/Sao_Paulo";
	private seq = 0;

	seed(userId: string, event: Partial<CalendarEventView> & Pick<CalendarEventView, "title" | "start" | "end">): CalendarEventView {
		const view: CalendarEventView = { id: `ev-${++this.seq}`, allDay: false, ...structuredClone(event) };
		this.events.push({ ...view, userId });
		return view;
	}
	private strip(event: CalendarEventView & { userId: string }): CalendarEventView {
		const { userId: _userId, ...view } = structuredClone(event);
		void _userId;
		return view;
	}
	private check(): void {
		if (this.fail) throw this.fail;
	}

	readonly ports: CalendarPorts = {
		calendar: {
			timeZone: async () => this.timeZoneValue,
			list: async (userId, range, options) => {
				this.check();
				if (this.failList) throw this.failList;
				const inRange = this.events
					.filter((e) => e.userId === userId && Date.parse(e.allDay ? `${e.end}T00:00:00Z` : e.end) > Date.parse(range.from) && Date.parse(e.allDay ? `${e.start}T00:00:00Z` : e.start) < Date.parse(range.to))
					.sort((a, b) => a.start.localeCompare(b.start))
					.map((e) => this.strip(e));
				const limit = options?.limit ?? 50;
				return { events: inRange.slice(0, limit), truncated: inRange.length > limit };
			},
			get: async (userId, id) => {
				this.check();
				const found = this.events.find((e) => e.userId === userId && e.id === id);
				return found ? this.strip(found) : null;
			},
			create: async (userId, draft, options) => {
				this.check();
				const prior = options.requestKey ? this.writes.find((w) => w.userId === userId && w.op === "create" && w.requestKey === options.requestKey) : undefined;
				const existing = prior?.id ? this.events.find((e) => e.id === prior.id) : undefined;
				if (existing) return this.strip(existing);
				const event: CalendarEventView & { userId: string } = {
					id: `ev-${++this.seq}`,
					userId,
					title: draft.title,
					start: draft.start,
					end: draft.end,
					allDay: draft.allDay,
					...(draft.location && { location: draft.location }),
					...(draft.description && { description: draft.description }),
					...(draft.attendees.length > 0 && { attendees: draft.attendees }),
					link: `https://calendar.example.com/event/${this.seq}`,
				};
				this.events.push(event);
				this.writes.push({ userId, op: "create", id: event.id, notifyGuests: options.notifyGuests, ...(options.requestKey && { requestKey: options.requestKey }) });
				return this.strip(event);
			},
			update: async (userId, id, patch, options) => {
				this.check();
				const event = this.events.find((e) => e.userId === userId && e.id === id);
				if (!event) return null;
				const { draft } = patch;
				Object.assign(event, { title: draft.title, start: draft.start, end: draft.end, allDay: draft.allDay });
				for (const key of ["location", "description"] as const) {
					if (draft[key]) event[key] = draft[key];
					else delete event[key];
				}
				if (draft.attendees.length > 0) event.attendees = draft.attendees;
				else delete event.attendees;
				this.writes.push({ userId, op: "update", id, notifyGuests: options.notifyGuests });
				return this.strip(event);
			},
			remove: async (userId, id) => {
				this.check();
				const at = this.events.findIndex((e) => e.userId === userId && e.id === id);
				if (at < 0) return false;
				this.events.splice(at, 1);
				this.writes.push({ userId, op: "remove", id });
				return true;
			},
		},
		cards: {
			show: async (userId, runId, card) => {
				if (!this.cards.some((c) => c.card.cardId === card.cardId)) this.cards.push({ userId, runId, card });
			},
		},
	};
}
