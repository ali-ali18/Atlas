// Stream SSE do run (`GET /v1/runs/:id/stream`), reconectável pelo cursor. Porta de `streamAgentRun`/
// `streamAgentRunLoop` do web: o servidor numera os eventos (`id:`), reenvia por `?after=` e `Last-Event-ID`, e o
// guarda de repetição (`createSseReplayGuard`, do shared) descarta o que já foi aplicado. Fontes e relógio são
// injetados: o teste usa fontes de mentira e a tela usa `expo/fetch` (ou XHR como plano B).
import { createSseReplayGuard, parseSseBlock, type ComputerUseEvent } from "@workspace/shared";
import { isRunBoundary, TERMINAL_RUN_STATUSES } from "./chat-live";

/** Sem nada (nem o keepalive do servidor, a cada 15 s) por tanto tempo, a conexão é tratada como morta. */
export const STREAM_IDLE_MS = 40_000;
export const isStreamIdle = (lastActivityAt: number, now: number, idleMs = STREAM_IDLE_MS): boolean => now - lastActivityAt >= idleMs;

/** Junta pedaços de texto e entrega os eventos completos (separados por linha em branco), guardando o resto. */
export class SseBuffer {
	private rest = "";
	push(text: string): string[] {
		this.rest += text.replace(/\r\n/g, "\n");
		const parts = this.rest.split("\n\n");
		this.rest = parts.pop() ?? "";
		return parts;
	}
}

/** O que o laço lê: texto em pedaços até acabar. `cancel` encerra a conexão. */
export type TextSource = {
	read: () => Promise<{ done: true } | { done: false; text: string }>;
	cancel: () => void;
};

export class StreamHttpError extends Error {
	constructor(readonly status: number) {
		super(`stream ${status}`);
	}
}

/** Adapta um `ReadableStream<Uint8Array>` (`response.body` do `expo/fetch`) a `TextSource`. */
export function sourceFromReader(reader: { read: () => Promise<{ done: boolean; value?: Uint8Array }>; cancel: () => Promise<void> }): TextSource {
	const decoder = new TextDecoder();
	return {
		read: async () => {
			const { done, value } = await reader.read();
			if (done || !value) return { done: true };
			return { done: false, text: decoder.decode(value, { stream: true }) };
		},
		cancel: () => void reader.cancel().catch(() => undefined),
	};
}

export type OpenStream = (cursor: number, signal: AbortSignal) => Promise<TextSource>;

export type FollowOptions = {
	open: OpenStream;
	after: number;
	signal: AbortSignal;
	onEvent: (event: ComputerUseEvent) => void;
	/** Cada id aplicado: guardado para retomar depois (cursor). */
	onCursor?: (seq: number) => void;
	/** Estado do run no servidor, para saber se o fim da conexão foi o fim do run. */
	runStatus: () => Promise<string | null>;
	/** "Voltei ao app": derruba a conexão atual para reconectar já. Devolve o cancelamento da assinatura. */
	subscribeResume?: (wake: () => void) => () => void;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	idleMs?: number;
	/** Acorda o vigia de silêncio (padrão a cada 5 s). */
	watchMs?: number;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type FollowResult = "boundary" | "terminal" | "aborted" | "gone";

/**
 * Segue o run até o fim: lê, aplica cada evento uma vez, e se a conexão cair reconecta do cursor com recuo.
 * Devolve por que parou. Erro HTTP 404 = run que não existe mais (`gone`); outros erros HTTP sobem.
 */
export async function followRun(options: FollowOptions): Promise<FollowResult> {
	const { signal } = options;
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? defaultSleep;
	const replay = createSseReplayGuard(options.after);
	const control: { conn: AbortController | null; last: number } = { conn: null, last: now() };
	const watchdog = setInterval(() => {
		if (control.conn && isStreamIdle(control.last, now(), options.idleMs)) control.conn.abort();
	}, options.watchMs ?? 5_000);
	const unsubscribe = options.subscribeResume?.(() => control.conn?.abort());
	let attempt = 0;
	try {
		while (!signal.aborted) {
			const conn = new AbortController();
			control.conn = conn;
			control.last = now();
			const relay = () => conn.abort();
			signal.addEventListener("abort", relay, { once: true });
			let source: TextSource;
			try {
				source = await options.open(replay.cursor, conn.signal);
			} catch (error) {
				signal.removeEventListener("abort", relay);
				if (signal.aborted) return "aborted";
				if (conn.signal.aborted) continue; // vigia ou volta ao app: tenta já
				if (error instanceof StreamHttpError && !isRetryableStatus(error.status)) {
					if (error.status === 404) return "gone"; // run que não existe mais
					throw error; // 401 (sessão) e outros 4xx: quem chamou decide
				}
				// 5xx, 429 ou rede caída antes de abrir: recuo e nova tentativa (o fim, se houve, é confirmado pelo estado do run)
				attempt += 1;
				const status = await options.runStatus().catch(() => null);
				if (status && TERMINAL_RUN_STATUSES.has(status)) return "terminal";
				await sleep(backoff(attempt));
				continue;
			}
			const buffer = new SseBuffer();
			conn.signal.addEventListener("abort", () => source.cancel(), { once: true });
			try {
				while (true) {
					if (signal.aborted) {
						source.cancel();
						return "aborted";
					}
					let chunk: Awaited<ReturnType<TextSource["read"]>>;
					try {
						chunk = await source.read();
					} catch {
						if (signal.aborted) return "aborted";
						break; // conexão morreu no meio: reconecta do cursor
					}
					if (chunk.done) break;
					control.last = now();
					attempt = 0;
					for (const part of buffer.push(chunk.text)) {
						if (signal.aborted) return "aborted";
						const parsed = parseSseBlock(part);
						if (!replay.accept(parsed.id)) continue;
						if (parsed.id !== undefined && parsed.id > 0) options.onCursor?.(parsed.id);
						if (!parsed.event) continue;
						options.onEvent(parsed.event);
						if (isRunBoundary(parsed.event)) {
							source.cancel();
							return "boundary";
						}
					}
				}
			} finally {
				signal.removeEventListener("abort", relay);
			}
			if (signal.aborted) return "aborted";
			const status = await options.runStatus().catch(() => null);
			if (status && TERMINAL_RUN_STATUSES.has(status)) return "terminal";
			attempt += 1;
			if (conn.signal.aborted) continue; // derrubada de propósito: reconecta sem esperar
			await sleep(backoff(attempt));
		}
		return "aborted";
	} finally {
		clearInterval(watchdog);
		unsubscribe?.();
	}
}

/** Erros do servidor e limite de ritmo passam; o resto do 4xx é resposta definitiva. */
export const isRetryableStatus = (status: number): boolean => status >= 500 || status === 429;

/** 0,8 s, 1,6 s, 3,2 s e 6,4 s: o teto é 6,4 s (o mesmo recuo do web, cuja constante de 8 s nunca é alcançada). */
export function backoff(attempt: number): number {
	return Math.min(8_000, 400 * 2 ** Math.min(attempt, 4));
}

/**
 * Plano B quando `response.body` não existe (RN sem streaming): `XMLHttpRequest` entrega o texto que já chegou a
 * cada `onprogress`. Cada pedaço novo é a fatia de `responseText` depois do que já foi lido.
 */
type Handler = (...args: never[]) => unknown;

export function sourceFromXhr(xhr: {
	readonly responseText: string;
	readonly readyState: number;
	readonly status: number;
	onprogress: Handler | null;
	onreadystatechange: Handler | null;
	onerror: Handler | null;
	onabort: Handler | null;
	abort: () => void;
}): TextSource {
	let offset = 0;
	let finished = false;
	let failed = false;
	let wake: (() => void) | null = null;
	const notify = () => {
		const resolve = wake;
		wake = null;
		resolve?.();
	};
	xhr.onprogress = notify;
	xhr.onreadystatechange = () => {
		if (xhr.readyState === 4) {
			finished = true;
			notify();
		}
	};
	xhr.onerror = () => {
		failed = true;
		finished = true;
		notify();
	};
	xhr.onabort = () => {
		finished = true;
		notify();
	};
	return {
		read: async () => {
			while (true) {
				if (xhr.readyState === 4) finished = true;
				if (xhr.responseText.length > offset) {
					const text = xhr.responseText.slice(offset);
					offset = xhr.responseText.length;
					return { done: false, text };
				}
				if (failed) throw new Error("conexão caiu");
				if (finished) return { done: true };
				await new Promise<void>((resolve) => {
					wake = resolve;
				});
			}
		},
		cancel: () => xhr.abort(),
	};
}
