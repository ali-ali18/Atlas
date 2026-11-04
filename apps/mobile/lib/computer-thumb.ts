// Miniatura ao vivo do cartão "Computador · Ação necessária": uma captura da tela da VM a cada poucos segundos, só
// enquanto o cartão está pendente e visível; ao resolver ou sair, para. O laço é puro (timers e busca injetados) para
// testar sem rede nem relógio. Nunca guarda a captura em disco nem em log: ela vive só no estado do cartão.
import { ComputerApiError, getComputerFrame, getComputerSession } from "./computer-api";
import type { ApiFetch } from "./home-sync";

/** Intervalo entre capturas ("a cada poucos segundos"). */
export const FRAME_INTERVAL_MS = 4_000;

export type FramePoller = { start: () => void; stop: () => void; readonly running: boolean };

export type FramePollerDeps = {
	/** Busca uma captura (`data:` URI) ou `null` se a VM ainda não tem tela. Lança `ComputerApiError`. */
	fetchFrame: () => Promise<string | null>;
	onFrame: (uri: string) => void;
	/** O servidor disse que não há o que mostrar (sessão sumiu, sem permissão): o laço para e a miniatura cai no vazio. */
	onGone?: () => void;
	intervalMs?: number;
	setTimer?: (run: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
};

const GONE: ReadonlySet<string> = new Set(["unauthorized", "not-found", "viewer-unavailable"]);

/**
 * Uma captura por vez: a próxima só é agendada depois que a anterior terminou (a rede lenta não empilha pedidos).
 * `stop()` cancela o timer e descarta a resposta que ainda estiver a caminho (nada de quadro depois de resolver).
 * Erro passageiro mantém o último quadro e tenta de novo; erro definitivo (`GONE`) para o laço.
 */
export function createFramePoller(deps: FramePollerDeps): FramePoller {
	const interval = deps.intervalMs ?? FRAME_INTERVAL_MS;
	const setTimer = deps.setTimer ?? ((run, ms) => setTimeout(run, ms));
	const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
	let generation = 0;
	let timer: unknown = null;
	let running = false;

	const tick = async (mine: number) => {
		timer = null;
		let gone = false;
		try {
			const uri = await deps.fetchFrame();
			if (mine === generation && uri) deps.onFrame(uri);
		} catch (error) {
			gone = error instanceof ComputerApiError && GONE.has(error.kind);
		}
		if (mine !== generation) return;
		if (gone) {
			running = false;
			deps.onGone?.();
			return;
		}
		timer = setTimer(() => void tick(mine), interval);
	};

	return {
		get running() {
			return running;
		},
		start() {
			if (running) return;
			running = true;
			generation += 1;
			void tick(generation);
		},
		stop() {
			running = false;
			generation += 1;
			if (timer !== null) clearTimer(timer);
			timer = null;
		},
	};
}

/** Busca de captura da conversa: acha a sessão ativa da VM (sem religá-la) e pede a captura. Sem VM ligada = `null`. */
export function conversationFrameFetcher(apiFetch: ApiFetch, conversationId: string): () => Promise<string | null> {
	let sessionId: string | null = null;
	return async () => {
		if (!sessionId) {
			const session = await getComputerSession(apiFetch, conversationId);
			if (!session || session.status !== "running") return null;
			sessionId = session.sessionId;
		}
		try {
			return await getComputerFrame(apiFetch, sessionId);
		} catch (error) {
			// A sessão pode ter sido trocada (VM reiniciada): na próxima volta acha a nova.
			if (error instanceof ComputerApiError && error.kind === "not-found") {
				sessionId = null;
				return null;
			}
			throw error;
		}
	};
}
