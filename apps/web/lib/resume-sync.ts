/** Ressincronização ao voltar do segundo plano (PWA no Android congela/mata conexões sem avisar). */

/** Sem nada (nem keepalive do servidor, a cada 15s) por tanto tempo, a conexão é tratada como morta. */
export const STREAM_IDLE_MS = 40_000;
/** Fora da tela por menos que isso, o app não perdeu a conexão: não vale ressincronizar. */
export const RESUME_MIN_HIDDEN_MS = 2_000;
/** Eventos de "acordou" muito próximos (visibility + focus + pageshow juntos) contam uma vez. */
export const RESUME_DEBOUNCE_MS = 1_500;

export type ResumeSignal = "visible" | "pageshow" | "focus" | "online";

export function isStreamIdle(lastActivityAt: number, now: number, idleMs = STREAM_IDLE_MS): boolean {
	return now - lastActivityAt >= idleMs;
}

/** Decide se um sinal de "voltei" deve disparar ressincronização. `hiddenAt` é null se nunca saiu. */
export function shouldResync(input: {
	signal: ResumeSignal;
	now: number;
	hiddenAt: number | null;
	lastResyncAt: number;
	persisted?: boolean;
}): boolean {
	if (input.now - input.lastResyncAt < RESUME_DEBOUNCE_MS) return false;
	switch (input.signal) {
		case "online":
			return true;
		case "pageshow":
			return input.persisted === true;
		case "visible":
		case "focus":
			return input.hiddenAt !== null && input.now - input.hiddenAt >= RESUME_MIN_HIDDEN_MS;
	}
}

/** Mensagens do servidor que o cliente ainda não tem (por id), na ordem recebida. */
export function newMessagesSince<T extends { id: string }>(known: readonly T[], fetched: readonly T[]): T[] {
	const ids = new Set(known.map((item) => item.id));
	const out: T[] = [];
	for (const item of fetched) {
		if (ids.has(item.id)) continue;
		ids.add(item.id);
		out.push(item);
	}
	return out;
}

/**
 * Chama `onResume` quando o app volta ao primeiro plano / rede. Retorna a função de limpeza.
 * `hiddenAt` só é zerado depois de um resync disparado por visibilidade/foco.
 */
export function subscribeAppResume(onResume: (signal: ResumeSignal) => void): () => void {
	if (typeof document === "undefined" || typeof window === "undefined") return () => undefined;
	let hiddenAt: number | null = document.visibilityState === "hidden" ? Date.now() : null;
	let lastResyncAt = 0;
	const fire = (signal: ResumeSignal, persisted?: boolean) => {
		const now = Date.now();
		if (!shouldResync({ signal, now, hiddenAt, lastResyncAt, persisted })) return;
		lastResyncAt = now;
		hiddenAt = null;
		onResume(signal);
	};
	const onVisibility = () => {
		if (document.visibilityState === "hidden") {
			if (hiddenAt === null) hiddenAt = Date.now();
		} else fire("visible");
	};
	const onPageShow = (event: PageTransitionEvent) => fire("pageshow", event.persisted);
	const onFocus = () => fire("focus");
	const onOnline = () => fire("online");
	document.addEventListener("visibilitychange", onVisibility);
	window.addEventListener("pageshow", onPageShow);
	window.addEventListener("focus", onFocus);
	window.addEventListener("online", onOnline);
	return () => {
		document.removeEventListener("visibilitychange", onVisibility);
		window.removeEventListener("pageshow", onPageShow);
		window.removeEventListener("focus", onFocus);
		window.removeEventListener("online", onOnline);
	};
}
