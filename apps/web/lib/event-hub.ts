/**
 * EventHub: UMA conexão por usuário com `GET /v1/events` (log ordenado com cursor), no lugar dos
 * polls de 1 s / 5 s / 30 s. Mantém a conexão (backoff, watchdog de 40 s, reconexão ao voltar do
 * segundo plano), descarta duplicados, entrega na ordem do cursor e roteia para quem assina
 * (por conversa, para a lista de bots, ou geral).
 *
 * O evento é um AVISO com ids: quem recebe busca o estado no servidor (a verdade). Perder a conexão não
 * perde nada: a reconexão retoma pelo cursor (`Last-Event-ID`); cursor velho demais vira `resync`.
 *
 * Este arquivo não depende de React nem de rede: o transporte e os timers entram por injeção.
 */

export type HubEvent = {
	seq: number;
	type: string;
	payload: Record<string, unknown>;
	at?: string;
};

export type HubStatus = "idle" | "connecting" | "connected" | "disconnected" | "unsupported";

/** Por que os assinantes devem refazer os snapshots (não confiar só nos eventos). */
export type ResyncReason = "ready" | "resync";

export type HubFrame =
	/** Qualquer byte recebido (inclui keepalive): prova de vida para o watchdog. */
	| { kind: "activity" }
	| { kind: "ready"; head: number }
	| { kind: "resync"; head: number }
	| { kind: "event"; event: HubEvent };

export type HubTransport = (request: { cursor: number | null; signal: AbortSignal; onFrame: (frame: HubFrame) => void }) => Promise<void>;

/** O servidor não tem o endpoint (404, `REALTIME_HUB` desligado, resposta que não é SSE): volta ao comportamento antigo. */
export class HubUnsupportedError extends Error {
	constructor(message = "events endpoint unavailable") {
		super(message);
		this.name = "HubUnsupportedError";
	}
}

/** Sem sessão (401): espera mais e tenta de novo, sem barulho. */
export class HubAuthError extends Error {
	constructor(message = "unauthorized") {
		super(message);
		this.name = "HubAuthError";
	}
}

export type EventHubDeps = {
	transport: HubTransport;
	now?: () => number;
	setTimeout?: (fn: () => void, ms: number) => unknown;
	clearTimeout?: (handle: unknown) => void;
	random?: () => number;
	/** Sem nenhum byte (nem keepalive, que o servidor manda a cada 15 s) por tanto tempo, a conexão é tratada como morta. */
	watchdogMs?: number;
	/** Espera por um evento que falta (fora de ordem) antes de reconectar para repetir pelo cursor. */
	gapTimeoutMs?: number;
	/** Voltar ao app com conexão com atividade mais recente que isso não reconecta. */
	freshMs?: number;
	authRetryMs?: number;
	maxBackoffMs?: number;
};

export const HUB_WATCHDOG_MS = 40_000;
const WATCHDOG_CHECK_MS = 5_000;

export type ConversationHubState = {
	/** Último `seq` de mensagem/cartão visto para a conversa. */
	lastMessageSeq: number;
	/** Último run visto (a partir de eventos `run`). */
	run: { runId: string; status: string; botId: string | null } | null;
};

const ACTIVE_RUN_STATUSES = new Set(["queued", "running", "retrying", "waiting_external"]);
const PARKED_RUN_STATUSES = new Set(["waiting_user", "paused"]);
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled", "budget_exhausted"]);

export function isActiveRunStatus(status: string | null | undefined): boolean {
	return Boolean(status) && ACTIVE_RUN_STATUSES.has(status as string);
}
export function isParkedRunStatus(status: string | null | undefined): boolean {
	return Boolean(status) && PARKED_RUN_STATUSES.has(status as string);
}
export function isTerminalRunStatus(status: string | null | undefined): boolean {
	return Boolean(status) && TERMINAL_RUN_STATUSES.has(status as string);
}

export function eventConversationId(event: HubEvent): string | null {
	const value = event.payload.conversationId;
	return typeof value === "string" && value ? value : null;
}

export function eventRunStatus(event: HubEvent): string | null {
	if (event.type !== "run") return null;
	const value = event.payload.status;
	return typeof value === "string" ? value : null;
}

/** Eventos que mudam a lista de bots (última mensagem, não lidas, bot novo/editado, run que começou/terminou). */
export function affectsBotList(event: HubEvent): boolean {
	return event.type === "message" || event.type === "read" || event.type === "bot" || event.type === "run" || event.type === "reflection";
}

type Listener<T> = (value: T) => void;

const MAX_CONVERSATION_STATES = 300;

export class EventHub {
	private readonly transport: HubTransport;
	private readonly now: () => number;
	private readonly schedule: (fn: () => void, ms: number) => unknown;
	private readonly cancel: (handle: unknown) => void;
	private readonly random: () => number;
	private readonly watchdogMs: number;
	private readonly gapTimeoutMs: number;
	private readonly freshMs: number;
	private readonly authRetryMs: number;
	private readonly maxBackoffMs: number;

	private status: HubStatus = "idle";
	private cursor: number | null = null;
	private running = false;
	private conn: AbortController | null = null;
	private abortReason: "poke" | "watchdog" | "gap" | "stop" | null = null;
	private lastActivity = 0;
	private wake: (() => void) | null = null;
	private watchdogTimer: unknown = null;
	private gapTimer: unknown = null;
	private pending = new Map<number, HubEvent>();
	private failures = 0;

	private readonly eventListeners = new Set<Listener<HubEvent>>();
	private readonly resyncListeners = new Set<Listener<ResyncReason>>();
	private readonly statusListeners = new Set<Listener<HubStatus>>();
	private readonly conversationListeners = new Map<string, Set<Listener<HubEvent>>>();
	private readonly botListeners = new Set<Listener<HubEvent>>();
	private readonly conversations = new Map<string, ConversationHubState>();

	constructor(deps: EventHubDeps) {
		this.transport = deps.transport;
		this.now = deps.now ?? (() => Date.now());
		this.schedule = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
		this.cancel = deps.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
		this.random = deps.random ?? Math.random;
		this.watchdogMs = deps.watchdogMs ?? HUB_WATCHDOG_MS;
		this.gapTimeoutMs = deps.gapTimeoutMs ?? 2_000;
		this.freshMs = deps.freshMs ?? 3_000;
		this.authRetryMs = deps.authRetryMs ?? 30_000;
		this.maxBackoffMs = deps.maxBackoffMs ?? 30_000;
	}

	// ---- assinaturas -------------------------------------------------------------------------------------

	getStatus(): HubStatus {
		return this.status;
	}
	getCursor(): number | null {
		return this.cursor;
	}
	getConversationState(conversationId: string): ConversationHubState | undefined {
		return this.conversations.get(conversationId);
	}

	/** Todos os eventos, na ordem do cursor. */
	subscribe(listener: Listener<HubEvent>): () => void {
		this.eventListeners.add(listener);
		return () => void this.eventListeners.delete(listener);
	}
	/** Só os eventos de uma conversa. */
	subscribeConversation(conversationId: string, listener: Listener<HubEvent>): () => void {
		let set = this.conversationListeners.get(conversationId);
		if (!set) {
			set = new Set();
			this.conversationListeners.set(conversationId, set);
		}
		set.add(listener);
		return () => {
			const current = this.conversationListeners.get(conversationId);
			current?.delete(listener);
			if (current && current.size === 0) this.conversationListeners.delete(conversationId);
		};
	}
	/** Eventos que mudam a lista de bots. */
	subscribeBots(listener: Listener<HubEvent>): () => void {
		this.botListeners.add(listener);
		return () => void this.botListeners.delete(listener);
	}
	/** `ready` e `resync`: refaça os snapshots (o que veio antes do cursor não é garantido). */
	onResync(listener: Listener<ResyncReason>): () => void {
		this.resyncListeners.add(listener);
		return () => void this.resyncListeners.delete(listener);
	}
	onStatus(listener: Listener<HubStatus>): () => void {
		this.statusListeners.add(listener);
		return () => void this.statusListeners.delete(listener);
	}

	// ---- ciclo de vida -----------------------------------------------------------------------------------

	start(): void {
		if (this.running) return;
		this.running = true;
		this.setStatus("connecting");
		this.armWatchdog();
		void this.loop();
	}

	stop(): void {
		if (!this.running && this.status === "idle") return;
		this.running = false;
		this.abort("stop");
		this.clearWatchdog();
		this.clearGapTimer();
		this.wake?.();
		this.pending.clear();
		this.setStatus("idle");
	}

	/**
	 * Voltou ao app / rede voltou / aba acordou: a conexão pode estar congelada sem erro. Reconecta já
	 * (pelo cursor), a menos que tenha havido atividade agora há pouco.
	 */
	poke(): void {
		if (!this.running || this.status === "unsupported") return;
		if (this.status === "connected" && this.now() - this.lastActivity < this.freshMs) return;
		this.failures = 0;
		if (this.conn) this.abort("poke");
		else this.wake?.();
	}

	// ---- laço de conexão ---------------------------------------------------------------------------------

	private abort(reason: "poke" | "watchdog" | "gap" | "stop"): void {
		this.abortReason = reason;
		this.conn?.abort();
	}

	private async loop(): Promise<void> {
		while (this.running) {
			const conn = new AbortController();
			this.conn = conn;
			this.abortReason = null;
			this.lastActivity = this.now();
			this.pending.clear();
			this.clearGapTimer();
			if (this.status !== "connecting") this.setStatus("connecting");
			let gotFrame = false;
			let error: unknown = null;
			const aborted = new Promise<void>((resolve) => conn.signal.addEventListener("abort", () => resolve(), { once: true }));
			try {
				const attempt = this.transport({
					cursor: this.cursor,
					signal: conn.signal,
					onFrame: (frame) => {
						if (conn.signal.aborted || this.conn !== conn) return;
						this.lastActivity = this.now();
						if (!gotFrame) {
							gotFrame = true;
							this.failures = 0;
							if (this.status !== "connected") this.setStatus("connected");
						}
						this.handleFrame(frame);
					},
				});
				attempt.catch(() => undefined);
				// o watchdog/poke precisam valer mesmo que o transporte não reaja ao abort
				await Promise.race([attempt, aborted]);
			} catch (caught) {
				error = caught;
			}
			if (this.conn === conn) this.conn = null;
			if (!this.running) break;

			const reason = this.abortReason;
			this.abortReason = null;
			if (error instanceof HubUnsupportedError) {
				this.setStatus("unsupported");
				this.running = false;
				this.clearWatchdog();
				break;
			}
			this.setStatus("disconnected");
			let delay: number;
			if (error instanceof HubAuthError) delay = this.authRetryMs;
			else if (reason === "poke") delay = 0;
			else if (reason === "watchdog" || reason === "gap") delay = 250;
			else if (gotFrame) delay = 500;
			else {
				this.failures += 1;
				delay = this.backoff(this.failures);
			}
			if (delay > 0) await this.sleep(delay);
		}
	}

	private backoff(failures: number): number {
		const base = Math.min(this.maxBackoffMs, 1_000 * 2 ** Math.max(0, failures - 1));
		return Math.round(base * (0.75 + 0.5 * this.random()));
	}

	private sleep(ms: number): Promise<void> {
		return new Promise<void>((resolve) => {
			const handle = this.schedule(() => {
				this.wake = null;
				resolve();
			}, ms);
			this.wake = () => {
				this.cancel(handle);
				this.wake = null;
				resolve();
			};
		});
	}

	private armWatchdog(): void {
		this.clearWatchdog();
		const tick = () => {
			if (!this.running) return;
			if (this.conn && this.now() - this.lastActivity >= this.watchdogMs) this.abort("watchdog");
			this.watchdogTimer = this.schedule(tick, WATCHDOG_CHECK_MS);
		};
		this.watchdogTimer = this.schedule(tick, WATCHDOG_CHECK_MS);
	}
	private clearWatchdog(): void {
		if (this.watchdogTimer !== null) this.cancel(this.watchdogTimer);
		this.watchdogTimer = null;
	}
	private clearGapTimer(): void {
		if (this.gapTimer !== null) this.cancel(this.gapTimer);
		this.gapTimer = null;
	}

	private setStatus(next: HubStatus): void {
		if (this.status === next) return;
		this.status = next;
		for (const listener of [...this.statusListeners]) this.safe(listener, next);
	}

	// ---- eventos -----------------------------------------------------------------------------------------

	private handleFrame(frame: HubFrame): void {
		switch (frame.kind) {
			case "activity":
				return;
			case "ready":
			case "resync":
				this.pending.clear();
				this.clearGapTimer();
				this.cursor = frame.head;
				for (const listener of [...this.resyncListeners]) this.safe(listener, frame.kind);
				return;
			case "event":
				this.handleEvent(frame.event);
				return;
		}
	}

	private handleEvent(event: HubEvent): void {
		const cursor = this.cursor;
		if (cursor !== null) {
			if (event.seq <= cursor) return; // duplicado (reenvio após reconexão)
			if (event.seq > cursor + 1) {
				// Fora de ordem: segura até o que falta chegar; se não chegar, reconecta e o servidor repete pelo cursor.
				this.pending.set(event.seq, event);
				this.armGapTimer();
				return;
			}
		}
		this.deliver(event);
		this.drainPending();
	}

	private drainPending(): void {
		while (this.cursor !== null) {
			const next = this.pending.get(this.cursor + 1);
			if (!next) break;
			this.pending.delete(next.seq);
			this.deliver(next);
		}
		for (const seq of [...this.pending.keys()]) if (this.cursor !== null && seq <= this.cursor) this.pending.delete(seq);
		if (this.pending.size === 0) this.clearGapTimer();
	}

	private armGapTimer(): void {
		if (this.gapTimer !== null) return;
		this.gapTimer = this.schedule(() => {
			this.gapTimer = null;
			if (this.pending.size > 0 && this.conn) this.abort("gap");
		}, this.gapTimeoutMs);
	}

	private deliver(event: HubEvent): void {
		this.cursor = event.seq;
		const conversationId = eventConversationId(event);
		if (conversationId) this.recordConversation(conversationId, event);
		for (const listener of [...this.eventListeners]) this.safe(listener, event);
		if (conversationId) {
			const set = this.conversationListeners.get(conversationId);
			if (set) for (const listener of [...set]) this.safe(listener, event);
		}
		if (affectsBotList(event)) for (const listener of [...this.botListeners]) this.safe(listener, event);
	}

	private recordConversation(conversationId: string, event: HubEvent): void {
		const previous = this.conversations.get(conversationId) ?? { lastMessageSeq: 0, run: null };
		let next = previous;
		if (event.type === "message") next = { ...previous, lastMessageSeq: event.seq };
		const status = eventRunStatus(event);
		const runId = event.payload.runId;
		if (status && typeof runId === "string" && event.payload.origin !== "subagent") {
			const botId = typeof event.payload.botId === "string" ? event.payload.botId : null;
			next = { ...next, run: { runId, status, botId } };
		}
		if (next === previous && this.conversations.has(conversationId)) return;
		this.conversations.delete(conversationId);
		this.conversations.set(conversationId, next);
		if (this.conversations.size > MAX_CONVERSATION_STATES) {
			const oldest = this.conversations.keys().next().value;
			if (oldest !== undefined) this.conversations.delete(oldest);
		}
	}

	private safe<T>(listener: Listener<T>, value: T): void {
		try {
			listener(value);
		} catch (error) {
			console.warn("event hub listener failed", error instanceof Error ? error.message : "unknown");
		}
	}
}
