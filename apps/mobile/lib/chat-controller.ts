// Controlador do chat de um bot, sem React: abre pelo cache, confere o servidor, segue o run ao vivo (SSE), envia,
// para, responde cartões e pagina. Todo o estado vive aqui, lido e escrito de forma síncrona (nada de ref
// defasada de render), e as dependências (API, stream, cache, relógio) entram por injeção para testar as corridas
// (envio durante o fim do run, parar antes do `runId`, toque duplo em aprovação…). O hook só assina e desenha.
import type { AgentActivity, CompactConversationResponse, ComputerUseEvent, LoginConnector } from "@workspace/shared";
import type { RunModelFields } from "./model-choice";
import { proposalErrorText, type BotProfileResult, type BotProposalResult, type ResolveDecision } from "./card-api";
import { optimisticAttachmentItems } from "./attachment-items";
import { toRefs, type OutgoingAttachment } from "./attachments";
import { ChatApiError, compactErrorText, isModelRejection, ModelUnavailableError, isNetworkError, isUnauthorized, sendErrorText, type AttachmentRef, type CreateRunInput, type CreateRunResult, type ResumeOptions } from "./chat-api";
import type { ConnectResultView } from "./connect-app";
import { connectorCanAuthorize, connectorOf } from "./request-cards";
import { homeBotFromProposal, withProposalResolution, type CardResolution } from "./bot-cards";
import { groupBotItems } from "./bot-thread";
import { withRoutineCards } from "./routine-cards";
import { applyRunEvent, createLiveState, startLiveRun, type LiveState } from "./chat-live";
import { followRun, type FollowOptions, type OpenStream } from "./chat-stream";
import { isActiveRunStatus } from "./event-hub";
import { initialSync, syncLine, syncReducer, type SyncAction, type SyncState } from "./chat-sync";
import { compactionMarkerText, dockedTaskList, mergeTail, oldestCursor, PAGE_SIZE, prependOlder, reconcile, sessionMessageToItem, withSourceMarkers, type MessagePage, type PageCursor } from "./chat-thread";
import type { ChatItem, Reaction, ReplyQuote } from "./chat-types";
import type { HomeBot } from "./home-types";
import { shouldMarkSeen } from "./read-state";
import { myReaction, sameReactions, toggleUserReaction } from "./message-actions";

export type ChatApi = {
	fetchPage: (conversationId: string, options: { limit?: number; before?: PageCursor | null }) => Promise<MessagePage>;
	createConversation: () => Promise<string>;
	createRun: (input: CreateRunInput) => Promise<CreateRunResult>;
	createRunInput: (runId: string, content: string, clientKey: string, replyToMessageId?: string, attachments?: AttachmentRef[]) => Promise<void>;
	cancelRun: (runId: string) => Promise<void>;
	getRunStatus: (runId: string) => Promise<string | null>;
	listActiveRuns: (conversationId: string) => Promise<{ id: string; status: string }[]>;
	submitQuestionnaire: (input: { conversationId: string; questionnaireId: string; botId: string; answers: Record<string, string | string[]> }) => Promise<{ runId: string | null }>;
	setReaction: (messageId: string, emoji: string) => Promise<void>;
	clearReaction: (messageId: string) => Promise<void>;
	markConversationUnread: (conversationId: string) => Promise<void>;
	compactConversation: (conversationId: string, focus?: string) => Promise<CompactConversationResponse>;
	resolveBotProposal: (input: { conversationId: string; proposalId: string; decision: ResolveDecision }) => Promise<BotProposalResult>;
	resolveBotProfile: (input: { conversationId: string; proposalId: string; decision: ResolveDecision }) => Promise<BotProfileResult>;
	resumeRun: (runId: string, options: ResumeOptions) => Promise<{ enqueued: boolean }>;
};

export type ChatCache = { load: () => Promise<ChatItem[] | null>; save: (items: readonly ChatItem[]) => Promise<void> };

export type ChatDeps = {
	api: ChatApi;
	openRunStream: (runId: string) => OpenStream;
	subscribeResume?: FollowOptions["subscribeResume"];
	/** Cache da conversa (chave por servidor + conta + conversa); `null` sem conta ou sem conversa. */
	cacheFor: (conversationId: string) => ChatCache | null;
	onUnauthorized: () => void;
	/** Um agente foi criado pelo cartão do chat: a home o recebe já (e atualiza em segundo plano). */
	onBotCreated?: (bot: HomeBot) => void | Promise<void>;
	/** Um perfil proposto foi aplicado: a home mostra o que mudou (hoje, só o nome). */
	onProfileApplied?: (botId: string, patch: { name?: string }) => void;
	/** Conecta o app de um cartão de conector (navegador + polling); vive no controller, não no cartão. */
	connect?: (connector: LoginConnector, signal: { aborted: boolean }) => Promise<ConnectResultView>;
	/** Troca o laço do stream (testes). */
	follow?: typeof followRun;
	sleep?: (ms: number) => Promise<void>;
	clientKey?: () => string;
	now?: () => number;
	/** Intervalo mínimo entre avisos à tela durante o texto chegando (o texto em si nunca se perde). */
	throttleMs?: number;
	retryDelays?: readonly number[];
	/** Janela que junta avisos do canal de eventos antes de conferir o fio (padrão 300 ms). */
	hubDebounceMs?: number;
	/** Timers do debounce (testes). */
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
	/** Campos de modelo do run (escolha do seletor, lida na hora do envio). Ausente = o servidor decide. */
	modelFields?: () => RunModelFields;
	/** A conversa acabou de ser criada por um envio (chat novo): quem guarda a escolha de modelo passa a gravar nela. */
	onConversationCreated?: (conversationId: string) => void;
	/** O servidor recusou o modelo enviado: quem guarda a escolha a apaga (volta ao modelo do bot). */
	onModelRejected?: () => void;
	/** A home mostra esta conversa como não lida (lido na hora da conferência). */
	isUnread?: () => boolean;
	/** A última mensagem está à vista e há o que limpar: quem implementa avisa o servidor e a home. */
	onSeen?: (seen: { botId: string | null; conversationId: string; lastMessageId: string }) => void;
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
	/** Um `/compact` rodando no servidor: a tela mostra "Compactando a conversa…" e segura novos envios. */
	compacting: boolean;
	decisions: Record<string, "approved" | "rejected">;
	answered: Record<string, Record<string, string | string[]>>;
	/** Cartões de proposta (chave `kind|proposalId`): a chamada em voo, a falha ou o resultado, antes do gravado chegar. */
	cards: Record<string, CardResolution>;
	/** Logins já resolvidos neste aparelho (vale na hora, antes de o servidor gravar o novo estado). */
	loginsDone: Record<string, true>;
	/** Conexões em andamento (`busy`) ou que não fecharam (`message`), por pedido de login. */
	connects: Record<string, { busy: boolean; message: string | null }>;
};

/** Fins de verdade do run (o "paused" não entra: é justamente o estado de quem espera o login). */
const ENDED_RUN_STATUSES = new Set(["completed", "failed", "cancelled", "budget_exhausted"]);
const ACTIVE_CONFLICT = "A conversa já tem uma tarefa em andamento";
const DEFAULT_RETRY = [400, 1_000, 2_000] as const;
/** Rajada de avisos do canal (mensagem + run + leitura) vira uma conferência só. */
const HUB_SYNC_DEBOUNCE_MS = 300;
const SAFE_ID = /^[\w.:-]{1,128}$/;

/** Id vindo do canal: só texto curto e sem estranhezas; qualquer outra coisa não vale. */
function safeId(value: unknown): string | null {
	return typeof value === "string" && SAFE_ID.test(value) ? value : null;
}

type Queued = { text: string; optimisticIds: string[]; replyToMessageId?: string; attachments?: AttachmentRef[] };

function initial(): ChatSnapshot {
	return { persisted: [], live: createLiveState(), hasMore: false, loadingOlder: false, following: false, creating: false, ready: false, sync: initialSync, error: null, compacting: false, decisions: {}, answered: {}, cards: {}, loginsDone: {}, connects: {} };
}

export class ChatController {
	private state: ChatSnapshot = initial();
	private published: ChatSnapshot = this.state;
	private listeners = new Set<() => void>();
	private timer: ReturnType<typeof setTimeout> | null = null;
	/** Conferência marcada por um aviso do canal de eventos (junta rajadas). */
	private hubSyncTimer: unknown = null;

	private botId: string | null;
	private conversationId: string | null;
	/** Um `/compact` em andamento. */
	private compacting = false;
	/** A conversa foi criada por este controlador (um `conversationId` que chegue depois da home não a troca). */
	private createdHere = false;
	private oldest: PageCursor | null = null;
	/** Leitura: último id enviado como lido e último visto numa conferência (por abertura). */
	private seenSentId: string | null = null;
	private seenBaselineId: string | null = null;
	/** Muda a cada abertura e ao descartar: respostas de uma geração velha são ignoradas. */
	private generation = 0;
	private disposed = false;
	/** Fila de chamadas de reação por fala (ver `react`). */
	private reactionTurns = new Map<string, Promise<void>>();

	// Run em curso. Escritos no momento do evento (não no render).
	private runId: string | null = null;
	private followToken = 0;
	/** Maior número de evento já aplicado por run: o replay (`after=0`) de um run já seguido não conta fim/erro de novo. */
	private seenSeq = new Map<string, number>();
	private abort: AbortController | null = null;
	private stopRequested = false;
	private queue: Queued[] = [];
	private connectSignal = { aborted: false };

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
		this.clearHubSync();
		this.seenSentId = null;
		this.seenBaselineId = null;
		this.state = { ...initial(), decisions: this.state.decisions, answered: this.state.answered, cards: this.state.cards, loginsDone: this.state.loginsDone, connects: this.state.connects };
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
		this.connectSignal.aborted = true;
		this.generation += 1;
		this.stopFollowing();
		this.clearHubSync();
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
	async syncTail(replace: boolean, generation = this.generation, quiet = false): Promise<boolean> {
		const convId = this.conversationId;
		if (!convId) return false;
		// `quiet`: conferência disparada pelo canal de eventos; não acende o "Verificando novas mensagens…" nem mostra "Sem conexão".
		const dispatchSync = (action: SyncAction) => (quiet ? undefined : this.dispatchSync(action));
		dispatchSync({ type: "start" });
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
			dispatchSync({ type: "success" });
			this.markSeen(convId, page.messages.at(-1)?.id ?? null);
			return true;
		} catch (reason) {
			if (generation === this.generation) dispatchSync({ type: isNetworkError(reason) ? "network-failure" : "failure" });
			this.fail(reason);
			return false;
		}
	}

	/** Última mensagem do servidor à vista: avisa que foi lida (some o marcador da home), uma vez por mensagem. */
	private markSeen(conversationId: string, lastId: string | null): void {
		if (this.disposed || !this.deps.onSeen) return;
		const baselineId = this.seenBaselineId;
		this.seenBaselineId = lastId;
		const unread = this.deps.isUnread?.() ?? false;
		if (!lastId || !shouldMarkSeen({ unread, lastId, lastSentId: this.seenSentId, baselineId })) return;
		this.seenSentId = lastId;
		this.deps.onSeen({ botId: this.botId, conversationId, lastMessageId: lastId });
	}

	/** Voltou do segundo plano: confere de novo (o run pode ter terminado ou ter mensagem nova). */
	async resume(): Promise<void> {
		if (this.disposed || this.abort) return; // o stream em curso já reconecta sozinho
		const generation = this.generation;
		if (await this.syncTail(false, generation)) await this.resumeActiveRun(generation);
	}

	retry = (): Promise<void> => this.resume();

	// ---- tempo real (canal de eventos) ------------------------------------------------------------------

	/**
	 * Aviso do canal de eventos (`GET /v1/events`). O evento só traz ids: aqui só se decide o que buscar no servidor.
	 * - outra conversa, tipo que não interessa ou id malformado: ignora;
	 * - `message`: confere o fim do fio (quieto, com debounce; `mergeTail` já deduplica);
	 * - `run` ativo sem stream local: segue o run (uma vez; o `follow` ocupa o `abort` na hora);
	 * - qualquer outro `run` (terminou, parou esperando): confere o fim.
	 * Com stream local em curso (ou um envio criando o run) os avisos não fazem nada: o próprio run entrega o conteúdo e
	 * o `finishRun` confere no fim. Nada do conteúdo do evento vai para log.
	 */
	onHubEvent(event: { type: string; payload: Record<string, unknown> }): void {
		const convId = this.conversationId;
		if (this.disposed || !convId || safeId(event.payload.conversationId) !== convId) return;
		if (event.type === "message") {
			if (!this.localRunBusy()) this.scheduleHubSync();
			return;
		}
		if (event.type !== "run" || event.payload.origin === "subagent") return;
		if (this.localRunBusy()) return;
		const runId = safeId(event.payload.runId);
		const status = event.payload.status;
		if (runId && typeof status === "string" && isActiveRunStatus(status)) {
			void this.follow(runId);
			return;
		}
		this.scheduleHubSync();
	}

	/** `ready`/`resync` do canal, ou consulta do plano B: refaz o fim do fio e procura run em andamento. */
	async onHubResync(): Promise<void> {
		if (this.disposed || this.localRunBusy()) return;
		const generation = this.generation;
		if (await this.syncTail(false, generation, true)) await this.resumeActiveRun(generation);
	}

	/** Há stream local do run (ou um envio criando o run): o canal não mexe no fio nem abre outro stream. */
	private localRunBusy(): boolean {
		return this.abort !== null || this.state.creating;
	}

	private scheduleHubSync(): void {
		if (this.hubSyncTimer !== null) return;
		const schedule = this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
		const generation = this.generation;
		this.hubSyncTimer = schedule(() => {
			this.hubSyncTimer = null;
			if (this.disposed || generation !== this.generation || this.localRunBusy()) return;
			void this.syncTail(false, generation, true);
		}, this.deps.hubDebounceMs ?? HUB_SYNC_DEBOUNCE_MS);
	}

	private clearHubSync(): void {
		if (this.hubSyncTimer === null) return;
		(this.deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)))(this.hubSyncTimer);
		this.hubSyncTimer = null;
	}

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
		// O replay recria falas e cartões do run: o que vinha dele sai; o que o usuário acabou de enviar (balão e cartões
		// de imagens e arquivos, ids `msg-*`) fica até o servidor gravar. Antes só o balão ficava e o cartão do anexo sumia.
		this.set({ following: true, live: { ...startLiveRun(this.state.live, runId), items: this.state.live.items.filter(isOptimisticSend) } });
		let terminal = false;
		const highWater = this.seenSeq.get(runId) ?? 0;
		let currentSeq = 0;
		try {
			const result = await (this.deps.follow ?? followRun)({
				open: this.deps.openRunStream(runId),
				after: 0,
				signal: controller.signal,
				onCursor: (seq: number) => {
					currentSeq = seq;
				},
				onEvent: (event: ComputerUseEvent) => {
					if (token !== this.followToken) return;
					const before = this.state.live;
					let next = applyRunEvent(before, event);
					// Evento repetido do replay: refaz falas e cartões, mas não dispara de novo a reação de fim ou de erro.
					if (currentSeq > 0 && currentSeq <= highWater) next = { ...next, failures: before.failures, finishes: before.finishes };
					if (currentSeq > (this.seenSeq.get(runId) ?? 0)) this.seenSeq.set(runId, currentSeq);
					this.set({ live: next }, event.type === "assistant_delta");
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
			this.set({ live: { ...live, phase: "idle", tool: null } });
			return;
		}
		// O gravado assumiu: só o que ainda não foi gravado (balão do usuário, erro do run) fica ao vivo.
		const keep = live.items.filter((item) => item.id === "cu-run-error" || isOptimisticSend(item));
		this.set({ live: { ...live, items: keep, runId: null, phase: "idle", tool: null } });
	}

	// ---- envio ------------------------------------------------------------------------------------------

	/** `replyTo`: a mensagem que esta responde; o balão otimista já mostra a citação e o servidor recebe só o id. */
	send(text: string, replyTo?: ReplyQuote, outgoing: readonly OutgoingAttachment[] = []): void {
		const trimmed = text.trim();
		if ((!trimmed && outgoing.length === 0) || this.disposed) return;
		this.set({ error: null });
		const baseId = `msg-${this.now}-${Math.random().toString(36).slice(2, 7)}`;
		const createdAt = new Date(this.now).toISOString();
		// Só anexo, sem texto: não há balão de fala (como no web); os cartões bastam.
		const optimistic: ChatItem[] = [
			...(trimmed ? [{ id: baseId, kind: "user" as const, text: trimmed, createdAt, ...(replyTo ? { replyTo } : {}) }] : []),
			...optimisticAttachmentItems(baseId, outgoing, createdAt),
		];
		const optimisticIds = optimistic.map((item) => item.id);
		const attachments = toRefs(outgoing);
		const live = this.state.live;
		this.set({ live: { ...live, items: [...live.items, ...optimistic], phase: live.phase === "idle" ? "thinking" : live.phase } });
		// Um envio ainda criando o run: a fala entra na fila (nada se perde) e segue como input do run assim que ele existir.
		if (this.state.creating) {
			this.queue.push({ text: trimmed, optimisticIds, ...(replyTo ? { replyToMessageId: replyTo.id } : {}), ...(attachments.length ? { attachments } : {}) });
			return;
		}
		void this.dispatch(trimmed, optimisticIds, replyTo?.id, attachments);
	}

	private dropOptimistic(ids: readonly string[]): void {
		const live = this.state.live;
		this.set({ live: { ...live, items: live.items.filter((item) => !ids.includes(item.id)), phase: this.abort ? live.phase : "idle" } });
	}

	private async dispatch(text: string, optimisticIds: string[], replyToMessageId?: string, attachments: AttachmentRef[] = []): Promise<void> {
		const generation = this.generation;
		try {
			const liveRun = this.abort ? this.runId : null;
			if (liveRun) {
				try {
					await this.deps.api.createRunInput(liveRun, text, this.newKey(), replyToMessageId, attachments);
					return;
				} catch (reason) {
					// O run terminou entre o toque e o envio: cai no fluxo de run novo.
					if (!(reason instanceof ChatApiError && reason.status === 409)) throw reason;
				}
			}
			this.set({ creating: true });
			const created = await this.startRun(text, undefined, replyToMessageId, attachments);
			if (generation !== this.generation) {
				this.stopRequested = false;
				return;
			}
			this.set({ creating: false });
			const runId = created.runId;
			if (!runId) {
				// O bot só reagiu (ex.: "valeu!"): a mensagem foi gravada e não há run. Um "parar" tocado nesse meio
				// não vale para o próximo envio (senão o run seguinte seria cancelado assim que nascesse).
				this.stopRequested = false;
				await this.syncTail(false);
				const live = this.state.live;
				this.set({ live: { ...live, phase: "idle", tool: null } });
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
			this.dropOptimistic(optimisticIds);
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
			await this.dispatch(first.text, first.optimisticIds, first.replyToMessageId, first.attachments);
			return;
		}
		for (const item of queued) {
			try {
				await this.deps.api.createRunInput(runId, item.text, this.newKey(), item.replyToMessageId, item.attachments);
			} catch (reason) {
				this.dropOptimistic(item.optimisticIds);
				this.fail(reason);
				this.set({ error: sendErrorText(reason) });
			}
		}
	}

	/** Cria o run; com a conversa ainda ocupada (409), espera um pouco e tenta de novo, como o web. */
	private async startRun(content: string, decisionConfirmId?: string, replyToMessageId?: string, attachments: AttachmentRef[] = []): Promise<CreateRunResult> {
		const botId = this.botId;
		if (!botId) throw new ChatApiError("Bot não encontrado.", 404);
		if (!this.conversationId) {
			this.conversationId = await this.deps.api.createConversation();
			this.createdHere = true;
			this.deps.onConversationCreated?.(this.conversationId);
		}
		const delays = this.deps.retryDelays ?? DEFAULT_RETRY;
		const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
		for (let attempt = 0; ; attempt += 1) {
			const model = this.deps.modelFields?.() ?? {};
			try {
				return await this.deps.api.createRun({ content, conversationId: this.conversationId, botId, ...(decisionConfirmId ? { decisionConfirmId } : {}), ...(replyToMessageId ? { replyToMessageId } : {}), ...(attachments.length ? { attachments } : {}), model, clientKey: this.newKey() });
			} catch (reason) {
				if (model.model && isModelRejection(reason)) {
					this.deps.onModelRejected?.();
					throw new ModelUnavailableError((reason as ChatApiError).status);
				}
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
				this.set({ live: { ...this.state.live, paused: false, ended: true, phase: "idle", tool: null } });
			}
			return;
		}
		// Ainda criando o run: guarda a intenção e cancela quando o `runId` chegar.
		if (this.state.creating) this.stopRequested = true;
	}

	// ---- cartões ----------------------------------------------------------------------------------------

	/** Clique de cartão: nunca vira fala nem input do run vivo; o servidor o resolve contra a intenção pendente. */
	decide(item: Pick<Extract<ChatItem, { kind: "confirm" }>, "confirmId" | "title" | "status">, approve: boolean): void {
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

	/**
	 * Resolve o pedido de login e retoma o run parado (como o `resumeRun` do web): "Terminei", "Entrar" pelo Cofre ou o
	 * código digitado. Se o run já voltou sozinho (a conexão feita pelo navegador pode tê-lo retomado), só acompanha.
	 */
	resumeLogin(item: Pick<Extract<ChatItem, { kind: "login" }>, "loginId" | "runId" | "status">, options: ResumeOptions = {}): void {
		if (item.status !== "pending" || this.state.loginsDone[item.loginId] || this.disposed) return;
		const runId = item.runId ?? this.runId;
		this.set({ error: null, loginsDone: { ...this.state.loginsDone, [item.loginId]: true } });
		void (async () => {
			try {
				if (!runId) throw new ChatApiError("Não achei a tarefa para continuar.", 404);
				const status = await this.deps.api.getRunStatus(runId).catch(() => null);
				if (status && ENDED_RUN_STATUSES.has(status)) {
					await this.syncTail(false);
					return;
				}
				if (status !== "queued" && status !== "running" && status !== "retrying") {
					const { enqueued } = await this.deps.api.resumeRun(runId, options);
					if (!enqueued) throw new ChatApiError("Não deu para continuar agora.", 503);
				}
				void this.follow(runId);
			} catch (reason) {
				const { [item.loginId]: _removed, ...rest } = this.state.loginsDone;
				this.set({ loginsDone: rest });
				this.fail(reason);
				if (!this.disposed) this.set({ error: isUnauthorized(reason) ? sendErrorText(reason) : "Não consegui continuar a tarefa agora. Tente de novo." });
			}
		})();
	}

	/**
	 * "Autorizar": conecta o app pelo navegador e, conectado, retoma o run (`resumeLogin`). O fluxo é do controller:
	 * rolar a lista (desmontar a linha) não o interrompe; sair do chat o aborta e fecha o navegador.
	 */
	connectLogin(item: Extract<ChatItem, { kind: "login" }>): void {
		const connector = connectorOf(item);
		const connect = this.deps.connect;
		if (!connector || !connect || !connectorCanAuthorize(connector) || item.status !== "pending" || this.state.loginsDone[item.loginId] || this.state.connects[item.loginId]?.busy || this.disposed) return;
		const setConnect = (value: { busy: boolean; message: string | null } | null) => {
			const { [item.loginId]: _old, ...rest } = this.state.connects;
			this.set({ connects: value ? { ...rest, [item.loginId]: value } : rest });
		};
		setConnect({ busy: true, message: null });
		const signal = this.connectSignal;
		void (async () => {
			const result = await connect(connector, signal);
			if (signal.aborted || this.disposed) return;
			if ("error" in result) return setConnect({ busy: false, message: result.error });
			if (result.outcome === "connected") {
				setConnect(null);
				return this.resumeLogin(item);
			}
			setConnect({ busy: false, message: result.outcome === "cancelled" ? null : "Não consegui confirmar a conexão. Toque em Autorizar para tentar de novo." });
		})();
	}

	answer(item: Extract<ChatItem, { kind: "questionnaire" }>, answers: Record<string, string | string[]>): void {
		const convId = this.conversationId;
		const botId = this.botId;
		if (!convId || !botId || item.status !== "pending" || this.state.answered[item.questionnaireId]) return;
		this.set({ error: null, answered: { ...this.state.answered, [item.questionnaireId]: answers } });
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

	/**
	 * "Criar agente" / "Atualizar perfil" e "Agora não" dos cartões de proposta. O toque trava o cartão na hora (um
	 * segundo toque não chama de novo); o resultado vale na tela antes de o servidor gravar, e a home recebe o bot novo.
	 */
	resolveProposal(item: Extract<ChatItem, { kind: "bot-proposal" | "bot-profile" }>, decision: ResolveDecision): void {
		const key = `${item.kind}|${item.proposalId}`;
		const convId = this.conversationId;
		const known = this.state.cards[key];
		if (item.status !== "pending" || known?.phase === "applying" || known?.phase === "done" || (known?.phase === "error" && known.locked)) return;
		const action = item.kind === "bot-proposal" ? "bot" : "profile";
		if (!convId) {
			this.set({ cards: { ...this.state.cards, [key]: { phase: "error", text: proposalErrorText(new ChatApiError("", 404), decision, action) } } });
			return;
		}
		this.set({ cards: { ...this.state.cards, [key]: { phase: "applying" } } });
		void (async () => {
			try {
				if (item.kind === "bot-proposal") {
					const result = await this.deps.api.resolveBotProposal({ conversationId: convId, proposalId: item.proposalId, decision });
					this.set({ cards: { ...this.state.cards, [key]: { phase: "done", status: result.status, ...(result.botId ? { botId: result.botId } : {}), name: result.name } } });
					// Também quando `unchanged` (já criado antes): a home pode não ter o bot (outro aparelho, atualização perdida).
					if (result.status === "approved" && result.botId) void this.deps.onBotCreated?.(homeBotFromProposal(item, { botId: result.botId, name: result.name }));
				} else {
					const result = await this.deps.api.resolveBotProfile({ conversationId: convId, proposalId: item.proposalId, decision });
					this.set({ cards: { ...this.state.cards, [key]: { phase: "done", status: result.status } } });
					if (result.status === "approved" && item.fields.includes("name") && item.after.name) this.deps.onProfileApplied?.(item.botId, { name: item.after.name });
				}
			} catch (reason) {
				this.fail(reason);
				if (this.disposed) return;
				// 404/409: a proposta já foi decidida ou não existe mais. Trava os botões e traz o estado gravado.
				const stale = reason instanceof ChatApiError && (reason.status === 404 || reason.status === 409);
				this.set({ cards: { ...this.state.cards, [key]: { phase: "error", text: proposalErrorText(reason, decision, action), ...(stale ? { locked: true } : {}) } } });
				if (stale) void this.syncTail(false);
			}
		})();
	}

	// ---- menu da mensagem ---------------------------------------------------------------------------------

	/** Põe (ou tira) as reações de uma fala gravada, na tela e no cache. `false` = a fala não está na lista. */
	private patchReactions(messageId: string, reactions: Reaction[] | undefined): boolean {
		let found = false;
		const persisted = this.state.persisted.map((item) => {
			if (item.id !== messageId || (item.kind !== "user" && item.kind !== "assistant")) return item;
			found = true;
			const { reactions: _old, ...rest } = item;
			return (reactions ? { ...rest, reactions } : rest) as ChatItem;
		});
		if (!found) return false;
		this.set({ persisted });
		this.persist(persisted, this.generation);
		return true;
	}

	/**
	 * Toque numa reação do menu: aparece na hora e o servidor confirma (PUT troca, DELETE tira quando é a mesma). Se
	 * falhar, volta ao que era e avisa.
	 */
	async react(messageId: string, emoji: string): Promise<void> {
		const item = this.state.persisted.find((candidate) => candidate.id === messageId);
		if (!item || (item.kind !== "user" && item.kind !== "assistant") || this.disposed) return;
		const previous = item.reactions;
		const removing = myReaction(previous) === emoji;
		const optimistic = toggleUserReaction(previous, emoji);
		this.patchReactions(messageId, optimistic);
		// Toques seguidos na mesma fala saem em ordem: sem isso um DELETE podia passar à frente do PUT que ele desfaz.
		const turn = (this.reactionTurns.get(messageId) ?? Promise.resolve()).then(async () => {
			try {
				if (removing) await this.deps.api.clearReaction(messageId);
				else await this.deps.api.setReaction(messageId, emoji);
			} catch (reason) {
				// Só desfaz se a tela ainda mostra o que ESTE toque pôs; um toque mais novo já mudou a reação.
				if (sameReactions(this.currentReactions(messageId), optimistic)) this.patchReactions(messageId, previous);
				this.fail(reason);
				if (!this.disposed) this.set({ error: isUnauthorized(reason) ? sendErrorText(reason) : "Não consegui reagir agora. Tente de novo." });
			}
		});
		this.reactionTurns.set(messageId, turn);
		await turn;
		if (this.reactionTurns.get(messageId) === turn) this.reactionTurns.delete(messageId);
	}

	private currentReactions(messageId: string): Reaction[] | undefined {
		const item = this.state.persisted.find((candidate) => candidate.id === messageId);
		return item && (item.kind === "user" || item.kind === "assistant") ? item.reactions : undefined;
	}

	/** "Marcar como não lida": a conversa inteira. `true` = deu certo (a tela volta para a lista). */
	async markUnread(): Promise<boolean> {
		const convId = this.conversationId;
		if (!convId || this.disposed) return false;
		try {
			await this.deps.api.markConversationUnread(convId);
			return true;
		} catch (reason) {
			this.fail(reason);
			if (!this.disposed) this.set({ error: isUnauthorized(reason) ? sendErrorText(reason) : "Não consegui marcar como não lida agora. Tente de novo." });
			return false;
		}
	}

	/**
	 * `/compact [foco]`: resume a conversa levada. O cartão "Conversa compactada" entra no fim do fio (mesmo id do que o
	 * servidor grava, então a releitura não duplica). Conversa curta ou recusa do servidor: aviso amigável. Um toque
	 * duplo não dispara duas compactações. `true` = compactou.
	 */
	async compact(focus?: string): Promise<boolean> {
		const convId = this.conversationId;
		if (this.disposed || this.compacting) return false;
		if (!convId) {
			this.set({ error: "Ainda não há o que compactar nesta conversa." });
			return false;
		}
		this.compacting = true;
		this.set({ error: null, compacting: true });
		try {
			const result = await this.deps.api.compactConversation(convId, focus);
			if (this.disposed || this.conversationId !== convId) return false;
			if (result.status === "noop") {
				this.set({ error: result.message });
				return false;
			}
			const item: ChatItem = { id: result.messageId, kind: "marker", text: compactionMarkerText(result.before, result.after) };
			if (!this.state.persisted.some((candidate) => candidate.id === item.id)) this.set({ persisted: [...this.state.persisted, item] });
			return true;
		} catch (reason) {
			this.fail(reason);
			if (!this.disposed) this.set({ error: compactErrorText(reason) });
			return false;
		} finally {
			this.compacting = false;
			if (!this.disposed) this.set({ compacting: false });
		}
	}

	dismissError(): void {
		this.set({ error: null });
	}
}

// ---- o que a tela desenha -----------------------------------------------------------------------------------

export type ChatView = {
	items: ChatItem[];
	/** Passos do run ativo (alimenta o perfil e a tela de Execuções; no chat a lista fica no fio como cartão). */
	runTasks: Extract<ChatItem, { kind: "task-list" }> | null;
	/** A última lista de tarefas da conversa (a execução anterior). */
	lastTasks: Extract<ChatItem, { kind: "task-list" }> | null;
	line: ReturnType<typeof syncLine>;
	running: boolean;
	/** O que o bot está fazendo agora (alimenta o avatar e o texto da linha de atividade). */
	activity: AgentActivity;
	/** Contadores de reação do avatar (ferramenta/run que falhou, run que terminou); ver `LiveState`. */
	failures: number;
	finishes: number;
};

/** Atividade do bot a partir do estado ao vivo. Rodando sem sinal ainda (criando o run, outro aparelho) conta como pensando. */
export function liveActivity(live: LiveState, running: boolean): AgentActivity {
	if (!running) return { phase: "idle" };
	switch (live.phase) {
		case "writing":
			return { phase: "writing" };
		case "tool":
			if (!live.tool) return { phase: "thinking" };
			return {
				phase: "tool",
				tool: live.tool.name,
				...(live.tool.step !== undefined ? { step: live.tool.step } : {}),
				...(live.tool.maxSteps !== undefined ? { maxSteps: live.tool.maxSteps } : {}),
				...(live.tool.arriving ? { arriving: true as const } : {}),
			};
		default:
			return { phase: "thinking" };
	}
}

/** Item otimista do envio do usuário (balão, imagens, arquivo): nasce em `send` com id `msg-*` e vale até o gravado assumir. */
function isOptimisticSend(item: ChatItem): boolean {
	return (item.kind === "user" || item.kind === "images" || item.kind === "web-card") && item.id.startsWith("msg-");
}

/** O toque no cartão vale na hora, antes de o servidor gravar o novo estado. */
function withLocalDecisions(item: ChatItem, snapshot: ChatSnapshot): ChatItem {
	if (item.kind === "confirm" && item.status === "pending" && snapshot.decisions[item.confirmId]) return { ...item, status: snapshot.decisions[item.confirmId]! };
	if (item.kind === "secrets" && item.status === "pending" && snapshot.decisions[item.confirmId]) return { ...item, status: snapshot.decisions[item.confirmId]! };
	if (item.kind === "login" && item.status === "pending" && snapshot.loginsDone[item.loginId]) return { ...item, status: "done" };
	if (item.kind === "questionnaire" && item.status === "pending" && snapshot.answered[item.questionnaireId]) return { ...item, status: "submitted", answers: snapshot.answered[item.questionnaireId]! };
	return withProposalResolution(item, snapshot.cards);
}

export function deriveView(snapshot: ChatSnapshot): ChatView {
	const merged = reconcile(
		snapshot.persisted.map((item) => withLocalDecisions(item, snapshot)),
		snapshot.live.items.map((item) => withLocalDecisions(item, snapshot)),
	);
	// `creating`: a fala já foi e o run ainda está sendo criado (pode levar segundos); conta como em andamento, senão
	// o "Pensando…" some e o botão volta a ser o de voz nesse meio-tempo.
	const running = snapshot.following || snapshot.live.paused || snapshot.creating;
	const runTasks = dockedTaskList(merged, running, snapshot.live.runId);
	const lastTasks = [...merged].reverse().find((item): item is Extract<ChatItem, { kind: "task-list" }> => item.kind === "task-list" && item.items.length > 0) ?? null;
	return {
		// Fala entre bots não é balão do usuário: vira a linha "N mensagens com X".
		items: withSourceMarkers(withRoutineCards(groupBotItems(merged))),
		runTasks,
		lastTasks,
		line: syncLine(snapshot.sync),
		running,
		activity: liveActivity(snapshot.live, running),
		failures: snapshot.live.failures,
		finishes: snapshot.live.finishes,
	};
}
