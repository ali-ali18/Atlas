import type { ComputerUseEvent } from "@workspace/shared";
import { isDurableRunStale } from "@workspace/shared";
import { closesRunStream, pausedClosingEvent } from "./run-observer.js";
import { sseEncode } from "./sse-encode.js";

/** Consulta de segurança (sem sinal do Redis): nunca abaixo de 500ms. */
export const RUN_STREAM_FALLBACK_POLL_MS = 500;
/** Estado do run (existência/status/liveness) é lido no máximo a cada tanto, salvo logo após eventos. */
export const RUN_STREAM_STATE_EVERY_MS = 2_000;
const KEEPALIVE_MS = 15_000;
const STALE_NOTICE_EVERY_MS = 10_000;
const PAGE = 200;
/** Eventos que costumam anteceder o fim do stream: confere o estado do run logo depois deles. */
const CLOSING_HINTS = new Set(["done", "error", "cancelled", "paused", "budget_exhausted"]);

export type RunStreamState = {
	status: string;
	leaseUntil: string | null;
	createdAt: string;
	updatedAt: string;
	jobEnqueuedAt: string | null;
};

export type RunStreamDeps = {
	getState: () => Promise<RunStreamState | null>;
	listEvents: (afterSeq: number, limit: number) => Promise<Array<{ seq: number; payload: unknown }>>;
	/** Liga o sinal de "eventos novos" (Redis). Devolve o unsubscribe. */
	subscribe?: (onWake: () => void) => () => void;
	io: {
		stopped: () => boolean;
		send: (bytes: Uint8Array) => void;
		/** Espera até `ms` ou até `wakeUp` (acordar antecipado). */
		wait: (ms: number) => Promise<void>;
		wakeUp: () => void;
	};
	now?: () => number;
};

/**
 * Loop do stream SSE de um run. Cada volta consulta SÓ os eventos novos (índice por runId+seq);
 * o estado do run (select curto) é lido quando não veio evento e (acabou de passar um evento
 * de encerramento OU passaram ~2s), e a espera acorda por sinal do Redis, com consulta de segurança a cada 500ms.
 * Semântica de Last-Event-ID preservada: cada evento sai com `id: seq`, em ordem.
 */
export async function runRunStream(cursorStart: number, deps: RunStreamDeps): Promise<void> {
	const { io } = deps;
	const clock = deps.now ?? Date.now;
	const encoder = new TextEncoder();
	let cursor = cursorStart;
	const send = (seq: number, data: unknown) => {
		const payload = data as { type?: string };
		io.send(encoder.encode(sseEncode({ id: seq, event: typeof payload?.type === "string" ? payload.type : "message", data })));
	};
	io.send(encoder.encode("retry: 2000\n\n"));
	const unsubscribe = deps.subscribe?.(() => io.wakeUp());
	let lastSentAt = clock();
	let lastStateAt = 0;
	let lastStaleSentAt = 0;
	let closeHint = false;
	try {
		while (!io.stopped()) {
			const events = await deps.listEvents(cursor, PAGE);
			if (io.stopped()) break;
			for (const event of events) {
				cursor = event.seq;
				send(event.seq, event.payload);
			}
			if (events.length > 0) {
				lastSentAt = clock();
				if (events.some((event) => CLOSING_HINTS.has((event.payload as { type?: string })?.type ?? ""))) closeHint = true;
				// Página cheia (backlog) ou evento de encerramento: volta já, sem esperar.
				if (events.length >= PAGE || closeHint) continue;
			} else {
				const due = closeHint || clock() - lastStateAt >= RUN_STREAM_STATE_EVERY_MS;
				if (due) {
					closeHint = false;
					lastStateAt = clock();
					const state = await deps.getState();
					if (io.stopped()) break;
					if (!state) {
						send(cursor, { type: "error", error: "Run not found" });
						break;
					}
					if (closesRunStream(state.status)) {
						// Eventos gravados entre a leitura dos eventos e a do status: esvazia antes de fechar.
						const tail = await deps.listEvents(cursor, PAGE);
						if (tail.length === 0) {
							const closing = pausedClosingEvent(state.status);
							if (closing) io.send(encoder.encode(sseEncode({ event: closing.type, data: closing })));
							break;
						}
						for (const event of tail) {
							cursor = event.seq;
							send(event.seq, event.payload);
						}
						lastSentAt = clock();
						closeHint = true;
						continue;
					}
					if (isDurableRunStale(state) && clock() - lastStaleSentAt > STALE_NOTICE_EVERY_MS) {
						lastStaleSentAt = clock();
						io.send(
							encoder.encode(
								sseEncode({
									event: "status",
									data: {
										type: "status",
										status: "stale",
										detail: "O worker parou de renovar o run. Verifique Redis e o processo do worker.",
									} satisfies ComputerUseEvent,
								}),
							),
						);
					}
				}
				if (clock() - lastSentAt >= KEEPALIVE_MS) {
					lastSentAt = clock();
					io.send(encoder.encode(": keepalive\n\n"));
				}
			}
			await io.wait(RUN_STREAM_FALLBACK_POLL_MS);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : "stream error";
		io.send(encoder.encode(sseEncode({ data: { type: "error", error: message } satisfies ComputerUseEvent })));
	} finally {
		unsubscribe?.();
	}
}
