/** Desconectar a UI encerra apenas a observação, nunca a tarefa autorizada. */
/**
 * Shutdown da API: encerra de forma limpa todos os streams SSE abertos. O cliente
 * vê o stream fechar e reconecta (`retry: 2000`) com Last-Event-ID, sem perder eventos.
 */
const openObserverStops = new Set<() => void>();
export function endAllObserverStreams(): number {
	const stops = [...openObserverStops];
	for (const stop of stops) stop();
	return stops.length;
}

export function createRunObserver(
	signal: AbortSignal,
	observe: (observer: {
		stopped: () => boolean;
		send: (bytes: Uint8Array) => void;
		/** Espera até `ms`, ou até `wakeUp` (sinal que chegou durante a volta anterior também conta). */
		wait: (ms: number) => Promise<void>;
		wakeUp: () => void;
	}) => Promise<void>,
): ReadableStream<Uint8Array> {
	let stopped = signal.aborted;
	let cancelled = false;
	let wake: (() => void) | undefined;
	let woken = false;
	const stop = () => { stopped = true; wake?.(); };
	openObserverStops.add(stop);
	return new ReadableStream<Uint8Array>({
		async start(controller) {
			signal.addEventListener("abort", stop, { once: true });
			try {
				await observe({
					stopped: () => stopped,
					send: (bytes) => { if (!stopped) controller.enqueue(bytes); },
					wakeUp: () => { woken = true; wake?.(); },
					wait: (ms) => new Promise<void>((resolve) => {
						if (stopped || woken) { woken = false; resolve(); return; }
						const timer = setTimeout(done, ms);
						function done() { clearTimeout(timer); wake = undefined; woken = false; resolve(); }
						wake = done;
					}),
				});
			} finally {
				signal.removeEventListener("abort", stop);
				openObserverStops.delete(stop);
				if (!cancelled) controller.close();
			}
		},
		cancel() { cancelled = true; openObserverStops.delete(stop); stop(); },
	});
}

export function closesRunStream(status: string): boolean {
	return ["paused", "completed", "failed", "cancelled", "budget_exhausted"].includes(status);
}

/**
 * Evento explícito antes de fechar o stream de um run `paused`. O cliente que
 * conecta depois do evento `paused` já persistido (cursor além dele) receberia
 * um fechamento mudo, indistinguível de queda de rede, e reconectaria em loop
 * até estourar o rate limit. Sem `id`: não avança o cursor de replay.
 */
export function pausedClosingEvent(status: string): { type: "paused"; reason: string } | null {
	return status === "paused"
		? { type: "paused", reason: "Aguardando ação do usuário" }
		: null;
}
