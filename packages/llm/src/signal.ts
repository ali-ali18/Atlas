/** Padrão: 2 min por chamada ao modelo. Sem teto, um stream travado segura
 * o run para sempre — nenhum limite de passos resolve, porque o agente fica
 * preso esperando UMA chamada. */
export const DEFAULT_MODEL_CALL_TIMEOUT_MS = 120_000;

/** Combina timeout próprio + sinal externo num único AbortSignal.
 * Timeout estourado aborta como `TimeoutError` (transitório, tenta de novo);
 * nunca confundir com cancelamento do usuário (`AbortError`). */
export function modelCallSignal(
	signal: AbortSignal | undefined,
	timeoutMs: number | undefined,
): AbortSignal | undefined {
	const timeout =
		timeoutMs === undefined || timeoutMs <= 0
			? DEFAULT_MODEL_CALL_TIMEOUT_MS
			: timeoutMs;
	const signals: AbortSignal[] = [AbortSignal.timeout(timeout)];
	if (signal) signals.push(signal);
	return AbortSignal.any(signals);
}
