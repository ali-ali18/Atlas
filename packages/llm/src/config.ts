import { abortable } from "./decision-budget.js";
/**
 * F4 — resiliência do LLM: fallback nativo do OpenRouter (`models`) + retry
 * por passo com backoff e jitter, antes do BullMQ refazer o job inteiro.
 */

/** `OPENROUTER_FALLBACK_MODELS="model-a,model-b"` → ["model-a", "model-b"]. */
export function readOpenRouterFallbackModels(
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	const raw = env.OPENROUTER_FALLBACK_MODELS ?? "";
	return raw
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

/** Uma segunda tentativa após 1s, com até 25% de jitter. */
export const OPENROUTER_STEP_RETRY_DELAYS_MS = [1000];

/** 429, 5xx e "could not verify credits" valem outra tentativa no passo. */
export function isRetryableLlmError(error: unknown): boolean {
	const status = (error as { status?: unknown })?.status;
	const message = error instanceof Error ? error.message : String(error);
	if (
		(error instanceof Error && error.name === "AbortError") ||
		/privacy|guardrail|data policy|zdr|zero[- ]data[- ]retention|incompatible|no endpoints|no available endpoints|allowed providers|not support|unauthori[sz]ed|invalid api key/i.test(
			message,
		)
	)
		return false;
	if (status === 401 || status === 403 || status === 400) return false;
	if (
		status === 429 ||
		(typeof status === "number" && status >= 500 && status <= 599)
	)
		return true;
	if (error instanceof Error && error.name === "TimeoutError") return true;
	return /could not verify credits|rate[- ]?limit|temporarily unavailable|timeout|timed out|^(?:HTTP |upstream |OpenRouter request failed with status )?5\d\d(?:\b|$)/i.test(
		message,
	);
}

export type SleepFn = (ms: number) => Promise<void>;

const defaultSleep: SleepFn = (ms: number) =>
	new Promise((resolve) => setTimeout(resolve, ms));

/** Roda `fn` até 1 + delays.length vezes; jitter de até +25% por espera. */
export async function withLlmStepRetry<T>(
	fn: () => Promise<T>,
	options: {
		delays?: readonly number[];
		sleep?: SleepFn;
		retryIf?: (error: unknown) => boolean;
		/** Chamado a cada retry (antes do backoff); telemetria, nunca altera o fluxo. */
		onRetry?: (error: unknown, attempt: number) => void;
		signal?: AbortSignal;
	} = {},
): Promise<T> {
	const delays = options.delays ?? OPENROUTER_STEP_RETRY_DELAYS_MS;
	const sleep = options.sleep ?? defaultSleep;
	const retryIf = options.retryIf ?? isRetryableLlmError;
	let attempt = 0;
	for (;;) {
		try {
			options.signal?.throwIfAborted();
			return await abortable(fn(), options.signal);
		} catch (error) {
			options.signal?.throwIfAborted();
			if (attempt >= delays.length || !retryIf(error)) throw error;
			const base = delays[attempt] ?? 0;
			attempt += 1;
			try {
				options.onRetry?.(error, attempt);
			} catch {
				// telemetria nunca derruba a chamada
			}
			await abortable(
				sleep(base + Math.floor(Math.random() * (base / 4))),
				options.signal,
			);
		}
	}
}
