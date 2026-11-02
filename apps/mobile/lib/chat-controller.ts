// Controlador do chat de um bot, sem React: abre pelo cache, confere o servidor, segue o run ao vivo (SSE), envia,
// para, responde cartões e pagina. Todo o estado vive aqui, lido e escrito de forma síncrona (nada de ref
// defasada de render), e as dependências (API, stream, cache, relógio) entram por injeção para testar as corridas
// (envio durante o fim do run, parar antes do `runId`, toque duplo em aprovação…). O hook só assina e desenha.
import type { ComputerUseEvent } from "@workspace/shared";
import { ChatApiError, isNetworkError, isUnauthorized, sendErrorText, type CreateRunInput, type CreateRunResult } from "./chat-api";
import { applyRunEvent, createLiveState, startLiveRun, type LiveState } from "./chat-live";
import { followRun, type FollowOptions, type OpenStream } from "./chat-stream";
import { initialSync, syncLine, syncReducer, type SyncAction, type SyncState } from "./chat-sync";
import { dockedTaskList, mergeTail, oldestCursor, PAGE_SIZE, prependOlder, reconcile, sessionMessageToItem, type MessagePage, type PageCursor } from "./chat-thread";
import type { ChatItem } from "./chat-types";

export type ChatApi = {
	fetchPage: (conversationId: string, options: { limit?: number; before?: PageCursor | null }) => Promise<MessagePage>;
	createConversation: () => Promise<string>;
	createRun: (input: CreateRunInput) => Promise<CreateRunResult>;
	createRunInput: (runId: string, content: string, clientKey: string) => Promise<void>;
	cancelRun: (runId: string) => Promise<void>;
	getRunStatus: (runId: string) => Promise<string | null>;
	listActiveRuns: (conversationId: string) => Promise<{ id: string; status: string }[]>;
	submitQuestionnaire: (input: { conversationId: string; questionnaireId: string; botId: string; answers: Record<string, string | string[]> }) => Promise<{ runId: string | null }>;
};

export type ChatCache = { load: () => Promise<ChatItem[] | null>; save: (items: readonly ChatItem[]) => Promise<void> };

export type ChatDeps = {
	api: ChatApi;
	openRunStream: (runId: string) => OpenStream;
	subscribeResume?: FollowOptions["subscribeResume"];
	/** Cache da conversa (chave por servidor + conta + conversa); `null` sem conta ou sem conversa. */
	cacheFor: (conversationId: string) => ChatCache | null;
	onUnauthorized: () => void;
	/** Troca o laço do stream (testes). */
	follow?: typeof followRun;
	sleep?: (ms: number) => Promise<void>;
	clientKey?: () => string;
	now?: () => number;
	/** Intervalo mínimo entre avisos à tela durante o texto chegando (o texto em si nunca se perde). */
	throttleMs?: number;
	retryDelays?: readonly number[];
};

export type ChatSnapshot = {
	persisted: ChatItem[];
	live: LiveState;
	hasMore: boolean;
	loadingOlder: boolean;
	/** Há um run sendo seguido ao vivo. */
	following: boolean;
	/** Um envio está criando o run (ainda sem `runId`). */
	creating: boolean;
	ready: boolean;
	sync: SyncState;
	error: string | null;
	decisions: Record<string, "approved" | "rejected">;
	answered: Record<string, true>;
};

const ACTIVE_CONFLICT = "A conversa já tem uma tarefa em andamento";
const DEFAULT_RETRY = [400, 1_000, 2_000] as const;

type Queued = { text: string; optimisticId: string };

function initial(): ChatSnapshot {
	return { persisted: [], live: createLiveState(), hasMore: false, loadingOlder: false, following: false, creating: false, ready: false, sync: initialSync, error: null, decisions: {}, answered: {} };
}

export class ChatController {
	private state: ChatSnapshot = initial();
	private published: ChatSnapshot = this.state;
	private listeners = new Set<() => void>();
	private timer: ReturnType<typeof setTimeout> | null = null;

	private botId: string | null;
	private conversationId: string | null;
	/** A conversa foi criada por este controlador (um `conversationId` que chegue depois da home não a troca). */
	private createdHere = false;
	private oldest: PageCursor | null = null;
	/** Muda a cada abertura e ao descartar: respostas de uma geração velha são ignoradas. */
	private generation = 0;
	private disposed = false;

	// Run em curso. Escritos no momento do evento (não no render).
	private runId: string | null = null;
	private followToken = 0;
	private abort: AbortController | null = null;
	private stopRequested = false;
	private queue: Queued[] = [];

	constructor(
		private readonly deps: ChatDeps,
		bot: { id: string | null; conversationId: string | null },
	) {
		this.botId = bot.id;
		this.conversationId = bot.conversationId;
	}

	// ---- assinatura -------------------------------------------------------------------------------------

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => void this.listeners.delete(listener);
	};

	getSnapshot = (): ChatSnapshot => this.published;

	private set(patch: Partial<ChatSnapshot>, throttled = false): void {
		this.state = { ...this.state, ...patch };
		if (!throttled) {
			this.publish();
			return;
		}
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			this.publish();
		}, this.deps.throttleMs ?? 80);
	}

	private publish(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		if (this.published === this.state) return;
		this.published = this.state;
		for (const listener of this.listeners) listener();
	}

	private dispatchSync(action: SyncAction): void {
		this.set({ sync: syncReducer(this.state.sync, action) });
	}

	private get now(): number {
		return (this.deps.now ?? Date.now)();
	}

	private newKey(): string {
		return (this.deps.clientKey ?? (() => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`))();
	}

	private fail(reason: unknown): void {
		if (isUnauthorized(reason)) this.deps.onUnauthorized();
	}

	// ---- abertura ---------------------------------------------------------------------------------------

	/** Abre o fio: cache na hora, depois confere o servidor e procura run em andamento. */
	async open(): Promise<void> {
		this.disposed = false; // (o React em desenvolvimento monta, desmonta e monta de novo)
		const generation = ++this.generation;
		this.stopFollowing();
		this.state = { ...initial(), decisions: this.state.decisions, answered: this.state.answered };
		this.publish();
		const convId = this.conversationId;
		const cache = convId ? this.deps.cacheFor(convId) : null;
		if (cache) {
			const cached = await cache.load().catch(() => null);
			if (generation !== this.generation) return;
			if (cached && cached.length > 0) {
				const first = cached[0];
				this.oldest = first ? { createdAt: first.createdAt ?? "", id: first.id } : null;
				this.set({ persisted: cached });
			}
		}
		this.set({ ready: true });
		if (await this.syncTail(true, generation)) await this.resumeActiveRun(generation);
	}

	/**
	 * A home mostrou outro bot, ou o bot ganhou a conversa depois (cache antigo, home sincronizando tarde): reabre o
	 * fio. Sem isso o primeiro envio criaria uma conversa paralela.
	 */
	update(bot: { id: string | null; conversationId: string | null }): void {
		if (this.disposed) return;
		const botChanged = bot.id !== this.botId;
		const conversationChanged = bot.conversationId !== this.conversationId && bot.conversationId !== null && !(this.createdHere && !botChanged);
		if (!botChanged && !conversationChanged) return;
		this.botId = bot.id;
		this.conversationId = bot.conversationId;
		this.createdHere = false;
		void this.open();
	}

	dispose(): void {
		this.disposed = true;
		this.generation += 1;
		this.stopFollowing();
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
	}

	private stopFollowing(): void {
		this.followToken += 1;
		this.abort?.abort();
		this.abort = null;
		this.runId = null;
		this.queue = [];
	}

	// ---- servidor -> tela -------------------------------------------------------------------------------

	private persist(items: readonly ChatItem[], generation: number): void {
		const convId = this.conversationId;
		const cache = convId ? this.deps.cacheFor(convId) : null;
		// Só grava se ainda for a mesma abertura (conta e conversa): nada de uma conta velha chega ao disco.
		if (cache && generation === this.generation && !this.disposed) void cache.save(items).catch(() => undefined);
	}

	/** Confere o servidor. `replace`: a primeira conferência troca o que veio do cache pelo fim de verdade. */
	async syncTail(replace: boolean, generation = this.generation): Promise<boolean> {
		const convId = this.conversationId;
		if (!convId) return false;
		this.dispatchSync({ type: "start" });
		try {
			const page = await this.deps.api.fetchPage(convId, { limit: PAGE_SIZE });
			if (generation !== this.generation) return false;
			const tail = page.messages.map(sessionMessageToItem).filter((item): item is ChatItem => item !== null);
			const merged = replace ? { items: tail, gap: true } : mergeTail(this.state.persisted, tail);
			if (merged.gap) {
				this.oldest = oldestCursor(page.messages);
				this.set({ hasMore: page.hasMore });
			}
			this.set({ persisted: merged.items });
			this.persist(merged.items, generation);
			this.dispatchSync({ type: "success" });
			return true;
		} catch (reason) {
			if (generation === this.generation) this.dispatchSync({ type: isNetworkError(reason) ? "network-failure" : "failure" });
			this.fail(reason);
			return false;
		}
	}

	/** Voltou do segundo plano: confere de novo (o run pode ter terminado ou ter mensagem nova). */
	async resume(): Promise<void> {
		if (this.disposed || this.abort) return; // o stream em curso já reconecta sozinho
		const generation = this.generation;
		if (await this.syncTail(false, generation)) await this.resumeActiveRun(generation);
	}

	retry = (): Promise<void> => this.resume();

	private async resumeActiveRun(generation: number): Promise<void> {
		const convId = this.conversationId;
		if (!convId || this.abort) return;
		try {
			const runs = await this.deps.api.listActiveRuns(convId);
			const active = runs.find((run) => run.status !== "paused");
			if (active && generation === this.generation && !this.abort) void this.follow(active.id);
		} catch (reason) {
			this.fail(reason);
		}
	}

	async loadOlder(): Promise<void> {
		const convId = this.conversationId;
		const before = this.oldest;
		if (!convId || !before || this.state.loadingOlder || !this.state.hasMore) return;
		const generation = this.generation;
		this.set({ loadingOlder: true });
		try {
			const page = await this.deps.api.fetchPage(convId, { limit: PAGE_SIZE, before });
			if (generation !== this.generation) return;
			const older = page.messages.map(sessionMessageToItem).filter((item): item is ChatItem => item !== null);
			this.oldest = oldestCursor(page.messages) ?? this.oldest;
			this.set({ persisted: prependOlder(this.state.persisted, older), hasMore: page.hasMore && page.messages.length > 0 });
		} catch (reason) {
			this.fail(reason);
		} finally {
			if (generation === this.generation) this.set({ loadingOlder: false });
		}
	}

	// ---- run ao vivo ------------------------------------------------------------------------------------

	/** Segue o run ao vivo. Sempre do começo (`after=0`): o servidor reenvia os eventos e o guarda descarta o que já foi visto. */
	async follow(runId: string): Promise<void> {
		this.abort?.abort();
		const token = ++this.followToken;
		const controller = new AbortController();
		this.abort = controller;
		this.runId = runId;
		// O replay recria falas e cartões do run: o que vinha dele sai, o balão do usuário fica.
		this.set({ following: true, live: { ...startLiveRun(this.state.live, runId), items: this.state.live.items.filter((item) => item.kind === "user") } });
		let terminal = false;
		try {
			const result = await (this.deps.follow ?? followRun)({
				open: this.deps.openRunStream(runId),
				after: 0,
				signal: controller.signal,
				onEvent: (event: ComputerUseEvent) => {
					if (token !== this.followToken) return;
					this.set({ live: applyRunEvent(this.state.live, event) }, event.type === "assistant_delta");
				},
				runStatus: () => this.deps.api.getRunStatus(runId),
				...(this.deps.subscribeResume ? { subscribeResume: this.deps.subscribeResume } : {}),
				...(this.deps.sleep ? { sleep: this.deps.sleep } : {}),
			});
			terminal = result === "terminal" || result === "gone";
		} catch (reason) {
			this.fail(reason);
			if (token === this.followToken && !controller.signal.aborted && !this.disposed) this.set({ error: isUnauthorized(reason) ? sendErrorText(reason) : "Perdi a conexão com a resposta. Puxe de novo ou envie outra mensagem." });
		}
		// Outro run assumiu (ou o chat fechou): este fim não toca em nada do novo.
		if (token !== this.followToken || controller.signal.aborted || this.disposed) return;
		this.abort = null;
		// Parou esperando a pessoa (aprovação): o run continua vivo no servidor e o `stop` ainda o alcança.
		const live = this.state.live;
		if (!live.paused || live.ended) this.runId = null;
		this.set({ following: false });
		await this.finishRun(token, terminal);
	}

	private async finishRun(token: number, terminal: boolean): Promise<void> {
		await this.syncTail(false);
		// Durante o `syncTail` pode ter começado outro run (um envio): o fim deste não apaga o dele.
		if (token !== this.followToken || this.disposed) return;
		const live = this.state.live;
		if (!(live.ended || terminal)) {
			this.set({ live: { ...live, phase: "idle" } });
			return;
		}
		// O gravado assumiu: só o que ainda não foi gravado (balão do usuário, erro do run) fica ao vivo.
		const keep = live.items.filter((item) => item.id === "cu-run-error" || (item.kind === "user" && item.id.startsWith("msg-")));
		this.set({ live: { ...live, items: keep, runId: null, phase: "idle" } });
	}

	// ---- envio ------------------------------------------------------------------------------------------

	send(text: string): void {
		const trimmed = text.trim();
		if (!trimmed || this.disposed) return;
		this.set({ error: null });
		const optimistic: ChatItem = { id: `msg-${this.now}-${Math.random().toString(36).slice(2, 7)}`, kind: "user", text: trimmed, createdAt: new Date(this.now).toISOString() };
		const live = this.state.live;
		this.set({ live: { ...live, items: [...live.items, optimistic], phase: live.phase === "idle" ? "thinking" : live.phase } });
		// Um envio ainda criando o run: a fala entra na fila (nada se perde) e segue como input do run assim que ele existir.
		if (this.state.creating) {
			this.queue.push({ text: trimmed, optimisticId: optimistic.id });
			return;
		}
		void this.dispatch(trimmed, optimistic.id);
	}

	private dropOptimistic(id: string): void {
		const live = this.state.live;
		this.set({ live: { ...live, items: live.items.filter((item) => item.id !== id), phase: this.abort ? live.phase : "idle" } });
	}

	private async dispatch(text: string, optimisticId: string): Promise<void> {
		const generation = this.generation;
		try {
			const liveRun = this.abort ? this.runId : null;
			if (liveRun) {
				try {
					await this.deps.api.createRunInput(liveRun, text, this.newKey());
					return;
				} catch (reason) {
					// O run terminou entre o toque e o envio: cai no fluxo de run novo.
					if (!(reason instanceof ChatApiError && reason.status === 409)) throw reason;
				}
			}
			this.set({ creating: true });
			const created = await this.startRun(text);
			if (generation !== this.generation) return;
			this.set({ creating: false });
			const runId = created.runId;
			if (!runId) {
				// O bot só reagiu (ex.: "valeu!"): a mensagem foi gravada e não há run.
				await this.syncTail(false);
				const live = this.state.live;
				this.set({ live: { ...live, phase: "idle" } });
				await this.drainQueue(null);
				return;
			}
			void this.follow(runId);
			if (this.stopRequested) {
				// O pedido de parar veio antes de o run existir: cancela assim que o `runId` chega.
				this.stopRequested = false;
				void this.deps.api.cancelRun(runId).catch(() => this.set({ error: "Não consegui parar agora. Tente de novo." }));
			}
			await this.drainQueue(runId);
		} catch (reason) {
			this.set({ creating: false });
			this.stopRequested = false;
			this.dropOptimistic(optimisticId);
			this.fail(reason);
			if (!this.disposed) this.set({ error: sendErrorText(reason) });
			await this.drainQueue(null);
		}
	}

	/** O que ficou na fila entra no run recém-criado; sem run, a primeira vira um envio normal e as outras esperam por ela. */
	private async drainQueue(runId: string | null): Promise<void> {
		const queued = this.queue.splice(0);
		if (queued.length === 0) return;
		if (!runId) {
			const [first, ...rest] = queued;
			if (!first) return;
			this.queue.push(...rest);
			await this.dispatch(first.text, first.optimisticId);
			return;
		}
		for (const item of queued) {
			try {
				await this.deps.api.createRunInput(runId, item.text, this.newKey());
			} catch (reason) {
				this.dropOptimistic(item.optimisticId);
				this.fail(reason);
				this.set({ error: sendErrorText(reason) });
			}
		}
	}

	/** Cria o run; com a conversa ainda ocupada (409), espera um pouco e tenta de novo, como o web. */
	private async startRun(content: string, decisionConfirmId?: string): Promise<CreateRunResult> {
		const botId = this.botId;
		if (!botId) throw new ChatApiError("Bot não encontrado.", 404);
		if (!this.conversationId) {
			this.conversationId = await this.deps.api.createConversation();
			this.createdHere = true;
		}
		const delays = this.deps.retryDelays ?? DEFAULT_RETRY;
		const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
		for (let attempt = 0; ; attempt += 1) {
			try {
				return await this.deps.api.createRun({ content, conversationId: this.conversationId, botId, ...(decisionConfirmId ? { decisionConfirmId } : {}), clientKey: this.newKey() });
			} catch (reason) {
				const delay = delays[attempt];
				const conflict = reason instanceof ChatApiError && reason.status === 409 && reason.message.startsWith(ACTIVE_CONFLICT);
				if (!conflict || delay === undefined) throw reason;
				await sleep(delay);
			}
		}
	}

	stop(): void {
		const runId = this.runId;
		if (runId) {
			void this.deps.api.cancelRun(runId).catch(() => {
				if (!this.disposed) this.set({ error: "Não consegui parar agora. Tente de novo." });
			});
			// Run parado esperando a pessoa não tem stream para trazer o "cancelado": encerra aqui.
			if (!this.abort) {
				this.runId = null;
				this.set({ live: { ...this.state.live, paused: false, ended: true, phase: "idle" } });
			}
			return;
		}
		// Ainda criando o run: guarda a intenção e cancela quando o `runId` chegar.
		if (this.state.creating) this.stopRequested = true;
	}

	// ---- cartões ----------------------------------------------------------------------------------------

	/** Clique de cartão: nunca vira fala nem input do run vivo; o servidor o resolve contra a intenção pendente. */
	decide(item: Extract<ChatItem, { kind: "confirm" }>, approve: boolean): void {
		// Segundo toque (ou cartão já decidido): ignora. A marca vale antes do `await`.
		if (item.status !== "pending" || this.state.decisions[item.confirmId]) return;
		this.set({ error: null, decisions: { ...this.state.decisions, [item.confirmId]: approve ? "approved" : "rejected" } });
		void (async () => {
			try {
				const created = await this.startRun(approve ? `confirmado: ${item.title}` : "cancela isso", item.confirmId);
				if (created.runId) void this.follow(created.runId);
				else await this.syncTail(false);
			} catch (reason) {
				const { [item.confirmId]: _removed, ...rest } = this.state.decisions;
				this.set({ decisions: rest });
				this.fail(reason);
				if (!this.disposed) this.set({ error: sendErrorText(reason) });
			}
		})();
	}

	answer(item: Extract<ChatItem, { kind: "questionnaire" }>, answers: Record<string, string | string[]>): void {
		const convId = this.conversationId;
		const botId = this.botId;
		if (!convId || !botId || item.status !== "pending" || this.state.answered[item.questionnaireId]) return;
		this.set({ error: null, answered: { ...this.state.answered, [item.questionnaireId]: true } });
		void (async () => {
			try {
				const { runId } = await this.deps.api.submitQuestionnaire({ conversationId: convId, questionnaireId: item.questionnaireId, botId, answers });
				if (runId) void this.follow(runId);
				else await this.syncTail(false);
			} catch (reason) {
				const { [item.questionnaireId]: _removed, ...rest } = this.state.answered;
				this.set({ answered: rest });
				this.fail(reason);
				if (!this.disposed) this.set({ error: sendErrorText(reason) });
			}
		})();
	}

	dismissError(): void {
		this.set({ error: null });
	}
}

// ---- o que a tela desenha -----------------------------------------------------------------------------------

export type ChatView = {
	items: ChatItem[];
	dock: Extract<ChatItem, { kind: "task-list" }> | null;
	line: ReturnType<typeof syncLine>;
	running: boolean;
};

/** O toque no cartão vale na hora, antes de o servidor gravar o novo estado. */
function withLocalDecisions(item: ChatItem, snapshot: ChatSnapshot): ChatItem {
	if (item.kind === "confirm" && item.status === "pending" && snapshot.decisions[item.confirmId]) return { ...item, status: snapshot.decisions[item.confirmId]! };
	if (item.kind === "questionnaire" && item.status === "pending" && snapshot.answered[item.questionnaireId]) return { ...item, status: "submitted" };
	return item;
}

export function deriveView(snapshot: ChatSnapshot): ChatView {
	const merged = reconcile(
		snapshot.persisted.map((item) => withLocalDecisions(item, snapshot)),
		snapshot.live.items.map((item) => withLocalDecisions(item, snapshot)),
	);
	const running = snapshot.following || snapshot.live.paused;
	const dock = dockedTaskList(merged, running, snapshot.live.runId);
	return { items: merged.filter((item) => item.id !== dock?.id), dock, line: syncLine(snapshot.sync), running };
}
