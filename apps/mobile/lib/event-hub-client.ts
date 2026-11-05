// Cola do EventHub com o aparelho: transporte (reaproveita o leitor SSE do run), ciclo de vida pelo AppState e o
// "plano B" de consulta periódica quando o canal não existe ou não se sustenta. Sem React: o teste injeta tudo.
import { HubAuthError, HubUnsupportedError, type EventHub, type HubFrame, type HubStatus, type HubTransport } from "./event-hub";
import { SseBuffer, StreamHttpError, type OpenStream } from "./chat-stream";

/** Lê um bloco SSE (`id:`/`event:`/`data:`) do `/v1/events`. null = comentário, keepalive ou bloco ilegível. Sem log do conteúdo. */
export function parseHubBlock(block: string): HubFrame | null {
	let name: string | undefined;
	const data: string[] = [];
	for (const raw of block.split("\n")) {
		const line = raw.trim();
		if (line.startsWith("event:")) name = line.slice(6).trim();
		else if (line.startsWith("data:")) data.push(line.slice(5).trim());
	}
	if (data.length === 0) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(data.join("\n"));
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const body = parsed as Record<string, unknown>;
	if (name === "ready" || name === "resync") {
		const head = typeof body.head === "number" ? body.head : Number.NaN;
		return Number.isFinite(head) ? { kind: name, head } : null;
	}
	if (typeof body.seq !== "number" || !Number.isFinite(body.seq) || typeof body.type !== "string") return null;
	const payload = body.payload && typeof body.payload === "object" && !Array.isArray(body.payload) ? (body.payload as Record<string, unknown>) : {};
	return { kind: "event", event: { seq: body.seq, type: body.type, payload, at: typeof body.at === "string" ? body.at : undefined } };
}

/**
 * Transporte do hub sobre um `OpenStream` (o mesmo leitor do stream do run). 401/403 = sem sessão; 404/405/501 = o
 * servidor não tem o canal (hub desligado); o resto sobe como falha de rede (o hub recua e tenta de novo).
 */
export function createHubTransport(open: OpenStream): HubTransport {
	return async ({ cursor, signal, onFrame }) => {
		let source: Awaited<ReturnType<OpenStream>>;
		try {
			source = await open(cursor ?? 0, signal);
		} catch (error) {
			if (error instanceof StreamHttpError) {
				if (error.status === 401 || error.status === 403) throw new HubAuthError();
				if (error.status === 404 || error.status === 405 || error.status === 501) throw new HubUnsupportedError();
			}
			if (signal.aborted) return;
			throw error;
		}
		const onAbort = () => source.cancel();
		signal.addEventListener("abort", onAbort, { once: true });
		const buffer = new SseBuffer();
		onFrame({ kind: "activity" });
		try {
			while (!signal.aborted) {
				const chunk = await source.read();
				if (chunk.done) return;
				onFrame({ kind: "activity" });
				for (const part of buffer.push(chunk.text)) {
					const frame = parseHubBlock(part);
					if (frame) onFrame(frame);
				}
			}
		} catch (error) {
			if (signal.aborted) return;
			throw error;
		} finally {
			signal.removeEventListener("abort", onAbort);
			source.cancel();
		}
	};
}

export type AppStateLike = {
	current: () => string;
	/** Avisa a cada mudança; devolve o cancelamento. */
	subscribe: (listener: (state: string) => void) => () => void;
};

/**
 * Bateria: o canal só fica aberto com o app em primeiro plano ("active"). Foi para segundo plano ou "inactive":
 * derruba a conexão (o cursor fica no hub). Voltou: reconecta já com o último cursor (`Last-Event-ID`).
 */
export function attachHubLifecycle(hub: Pick<EventHub, "start" | "stop">, appState: AppStateLike): () => void {
	if (appState.current() === "active") hub.start();
	const unsubscribe = appState.subscribe((state) => {
		if (state === "active") hub.start();
		else hub.stop();
	});
	return () => {
		unsubscribe();
		hub.stop();
	};
}

/** Intervalos do plano B (sem canal): home mais espaçada que o chat aberto. */
export const HOME_POLL_MS = 45_000;
export const CHAT_POLL_MS = 12_000;

export type FallbackPollerDeps = {
	hub: { getStatus: () => HubStatus } | null;
	appState: AppStateLike;
	intervalMs: number;
	/** A tela que consulta está em foco. */
	isFocused: () => boolean;
	tick: () => void;
	setInterval?: (fn: () => void, ms: number) => unknown;
	clearInterval?: (handle: unknown) => void;
};

/**
 * Consulta de tempos em tempos SÓ quando o canal não está servindo (sem hub, 404, desconectado/reconectando) e
 * apenas com o app em primeiro plano e a tela em foco. Conectado = zero consultas. Devolve a parada.
 */
export function startFallbackPoller(deps: FallbackPollerDeps): () => void {
	const every = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
	const clear = deps.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
	const handle = every(() => {
		if (deps.appState.current() !== "active" || !deps.isFocused()) return;
		if (deps.hub?.getStatus() === "connected") return;
		deps.tick();
	}, deps.intervalMs);
	return () => clear(handle);
}
