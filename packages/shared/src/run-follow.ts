/**
 * Política de acompanhamento (SSE) de um run no cliente. Funções puras: quem
 * decide se reconecta, espera o usuário ou para; o hook só executa.
 *
 * Por quê: um run `paused` (esperando login/captcha) fecha o stream no
 * servidor. Tratar esse fechamento como queda de rede fazia o cliente
 * reconectar em loop (>30/min), estourar o rate limit e piscar "trabalhando".
 */

export const RUN_FOLLOW_BACKOFF_BASE_MS = 2_000;
export const RUN_FOLLOW_BACKOFF_MAX_MS = 30_000;

const TERMINAL = new Set(["completed", "failed", "cancelled", "budget_exhausted"]);

export type RunFollowAction =
	/** Anexar/reanexar o stream. */
	| "follow"
	/** Parado esperando ação do usuário (login/captcha): não reconectar. */
	| "wait_user"
	/** Terminal ou desconhecido: nada a acompanhar. */
	| "stop";

export function isTerminalRunStatus(status: string | null | undefined): boolean {
	return Boolean(status && TERMINAL.has(status));
}

/** Backoff exponencial 2s, 4s, 8s... até 30s. `failures` conta a partir de 1. */
export function runFollowBackoffMs(failures: number): number {
	const n = Math.max(1, Math.floor(failures));
	return Math.min(RUN_FOLLOW_BACKOFF_MAX_MS, RUN_FOLLOW_BACKOFF_BASE_MS * 2 ** (n - 1));
}

/** Decisão ao descobrir o status do run (início do follow ou poll). */
export function decideRunFollow(status: string | null | undefined): RunFollowAction {
	if (!status) return "stop";
	if (status === "paused") return "wait_user";
	if (isTerminalRunStatus(status)) return "stop";
	return "follow";
}

export type StreamFailureDecision =
	| { action: "stop" }
	| { action: "wait_user" }
	| { action: "retry"; delayMs: number };

/**
 * Decisão quando o stream terminou com erro (ou caiu).
 * `failures` = falhas seguidas já contadas, incluindo esta (>=1).
 */
export function decideStreamFailure(input: {
	runStatus: string | null | undefined;
	aborted: boolean;
	httpStatus?: number;
	failures: number;
}): StreamFailureDecision {
	if (input.aborted) return { action: "stop" };
	const base = decideRunFollow(input.runStatus);
	if (base === "wait_user") return { action: "wait_user" };
	if (base === "stop" && input.runStatus) return { action: "stop" };
	// 404/401/403 não melhoram com o tempo.
	if (input.httpStatus === 404 || input.httpStatus === 401 || input.httpStatus === 403) {
		return { action: "stop" };
	}
	// 429 e queda de rede num run vivo (ou status desconhecido): backoff.
	return { action: "retry", delayMs: runFollowBackoffMs(input.failures) };
}
