/**
 * F0 — medição por chamada ao modelo: tempo total, TTFT, tentativas e modelo
 * servido. Só metadados (nunca prompt, resposta nem headers).
 */

export type LlmRetryReason =
	| "rate_limit"
	| "server_error"
	| "credits"
	| "timeout"
	| "other";

export type LlmCallTiming = {
	/** Da primeira tentativa até o fim do corpo (inclui retries e backoff). */
	totalMs: number;
	/** Do início até o primeiro chunk do stream (só no streaming). */
	ttftMs?: number;
	/** 1 = sem retry. */
	attempts: number;
	/** Categoria do motivo de cada retry, na ordem. */
	retryReasons: LlmRetryReason[];
	requestedModel: string;
	/** Campo `model` da resposta do OpenRouter. */
	servedModel: string;
};

/** Categoria do erro que motivou o retry (sem mensagem do provider). */
export function retryReasonCategory(error: unknown): LlmRetryReason {
	const status = (error as { status?: unknown })?.status;
	if (status === 429) return "rate_limit";
	if (typeof status === "number" && status >= 500 && status <= 599) {
		return "server_error";
	}
	const message = error instanceof Error ? error.message : String(error);
	if (/could not verify credits/i.test(message)) return "credits";
	if (/rate[- ]?limit/i.test(message)) return "rate_limit";
	if (/timeout|timed out|abort/i.test(message)) return "timeout";
	if (/temporarily unavailable|5\d\d/.test(message)) return "server_error";
	return "other";
}

export type CallTimer = {
	onRetry: (error: unknown) => void;
	markFirstChunk: () => void;
	finish: (servedModel: string) => LlmCallTiming;
};

export function createCallTimer(
	requestedModel: string,
	now: () => number = () => performance.now(),
): CallTimer {
	const start = now();
	const retryReasons: LlmRetryReason[] = [];
	let ttftMs: number | undefined;
	return {
		onRetry: (error) => {
			retryReasons.push(retryReasonCategory(error));
		},
		markFirstChunk: () => {
			if (ttftMs === undefined) ttftMs = Math.max(0, Math.round(now() - start));
		},
		finish: (servedModel) => ({
			totalMs: Math.max(0, Math.round(now() - start)),
			...(ttftMs !== undefined ? { ttftMs } : {}),
			attempts: retryReasons.length + 1,
			retryReasons,
			requestedModel,
			servedModel,
		}),
	};
}
