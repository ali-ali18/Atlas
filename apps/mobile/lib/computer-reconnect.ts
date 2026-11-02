// Conexão da tela do Computador: reconexão automática com recuo exponencial e limite de tentativas. O token do
// WebSocket vale 10 min e só é conferido na hora de conectar, então cada (re)conexão pede um link novo. Máquina de
// estados pura: o relógio entra por parâmetro (`now`) e o efeito (pedir link e conectar) é só um valor devolvido.

export type ReconnectPhase = "connecting" | "connected" | "waiting" | "failed" | "stopped";
export type ReconnectState = {
	phase: ReconnectPhase;
	/** Falhas seguidas (só zera depois de uma conexão ESTÁVEL, ver `STABLE_MS`). */
	attempts: number;
	/** Quando tentar de novo (só em "waiting"). */
	retryAt: number | null;
	/** Instante em que conectou (só em "connected"). */
	connectedAt: number | null;
};

/** Quedas seguidas aceitas antes de desistir e mostrar "Tentar de novo". */
export const MAX_ATTEMPTS = 6;
/** Primeira espera; dobra a cada queda até `MAX_DELAY_MS`. */
export const BASE_DELAY_MS = 1_000;
export const MAX_DELAY_MS = 15_000;
/**
 * Quanto a conexão precisa durar para a conta de quedas zerar. Servidor que aceita o WebSocket e fecha em seguida não
 * conta como conexão boa: sem isto o app repetiria para sempre (e pediria um token novo a cada volta).
 */
export const STABLE_MS = 10_000;

export type ReconnectEvent =
	| { t: "start" } // abrir a primeira conexão
	| { t: "stop" } // a tela saiu de foco (ou o app foi para segundo plano): para tudo, sem tentar de novo
	| { t: "connected" }
	| { t: "dropped" } // caiu, ou o link novo falhou: tenta de novo com recuo
	| { t: "fatal" } // erro que repetir não resolve (segurança, credencial, sessão sumiu)
	| { t: "tick" } // o relógio andou: vê se já é hora
	| { t: "retry" }; // o usuário tocou em "Tentar de novo"

export type ReconnectAction = "connect" | "none";

export const initialReconnect: ReconnectState = { phase: "connecting", attempts: 0, retryAt: null, connectedAt: null };

/** Espera antes da tentativa depois de `attempts` quedas seguidas (1 → 1 s, 2 → 2 s, 3 → 4 s … no máximo 15 s). */
export function backoffDelay(attempts: number): number {
	if (attempts <= 0) return 0;
	return Math.min(BASE_DELAY_MS * 2 ** (attempts - 1), MAX_DELAY_MS);
}

/** Um passo da máquina. `action: "connect"` manda pedir um link novo e conectar. */
export function reconnectStep(state: ReconnectState, event: ReconnectEvent, now: number): { state: ReconnectState; action: ReconnectAction } {
	// Parada: só `start` recomeça. Evento atrasado (queda, conexão, relógio, "tentar de novo") de antes da parada não faz nada.
	if (state.phase === "stopped" && event.t !== "start") return { state, action: "none" };
	switch (event.t) {
		case "stop":
			return { state: { phase: "stopped", attempts: 0, retryAt: null, connectedAt: null }, action: "none" };
		case "start":
			return { state: { phase: "connecting", attempts: 0, retryAt: null, connectedAt: null }, action: "connect" };
		case "connected":
			// Só vale se estávamos tentando (evento atrasado de uma conexão antiga não reabre uma tela que desistiu).
			// As tentativas só zeram na queda seguinte, se esta conexão durou `STABLE_MS`.
			return state.phase === "failed" ? { state, action: "none" } : { state: { phase: "connected", attempts: state.attempts, retryAt: null, connectedAt: now }, action: "none" };
		case "dropped": {
			if (state.phase === "failed" || state.phase === "waiting") return { state, action: "none" };
			const stable = state.phase === "connected" && state.connectedAt !== null && now - state.connectedAt >= STABLE_MS;
			const attempts = (stable ? 0 : state.attempts) + 1;
			if (attempts > MAX_ATTEMPTS) return { state: { phase: "failed", attempts, retryAt: null, connectedAt: null }, action: "none" };
			return { state: { phase: "waiting", attempts, retryAt: now + backoffDelay(attempts), connectedAt: null }, action: "none" };
		}
		case "fatal":
			return { state: { phase: "failed", attempts: state.attempts, retryAt: null, connectedAt: null }, action: "none" };
		case "tick":
			if (state.phase === "waiting" && state.retryAt !== null && now >= state.retryAt) return { state: { phase: "connecting", attempts: state.attempts, retryAt: null, connectedAt: null }, action: "connect" };
			return { state, action: "none" };
		case "retry":
			return state.phase === "failed" ? { state: { phase: "connecting", attempts: 0, retryAt: null, connectedAt: null }, action: "connect" } : { state, action: "none" };
	}
}

/** Em quantos ms o relógio precisa avisar (`tick`), ou null se não há espera. */
export function msUntilRetry(state: ReconnectState, now: number): number | null {
	return state.phase === "waiting" && state.retryAt !== null ? Math.max(0, state.retryAt - now) : null;
}
