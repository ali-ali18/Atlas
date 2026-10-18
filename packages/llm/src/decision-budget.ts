export type DecisionBudgetOptions = {
	signal?: AbortSignal;
	timeoutMs?: number;
	/**
	 * Teto total depois que o stream começou a produzir (geração longa, ex.: arquivo grande).
	 * Antes do 1º evento vale `timeoutMs`; depois, enquanto houver progresso (vigiado pelo
	 * `idleTimeoutMs`), o teto sobe para este valor. Omitido = igual a `timeoutMs`.
	 */
	progressTimeoutMs?: number;
	deadlineAtMs?: number;
	firstEventTimeoutMs?: number;
	idleTimeoutMs?: number;
};

function duration(value: unknown, fallback: number, name: string): number {
	if (value === undefined) return fallback;
	const parsed =
		typeof value === "string" && value.trim() ? Number(value) : value;
	if (
		typeof parsed !== "number" ||
		!Number.isInteger(parsed) ||
		parsed < 1 ||
		parsed > 3_600_000
	)
		throw new RangeError(`${name} must be an integer from 1 to 3600000`);
	return parsed;
}

export function readDecisionTimeouts(
	options: DecisionBudgetOptions,
	env: NodeJS.ProcessEnv = process.env,
) {
	return {
		totalMs: duration(
			options.timeoutMs ?? env.LLM_DECISION_TIMEOUT_MS,
			90_000,
			"timeoutMs",
		),
		firstMs: duration(
			options.firstEventTimeoutMs ?? env.LLM_FIRST_EVENT_TIMEOUT_MS,
			30_000,
			"firstEventTimeoutMs",
		),
		idleMs: duration(
			options.idleTimeoutMs ?? env.LLM_IDLE_TIMEOUT_MS,
			20_000,
			"idleTimeoutMs",
		),
	};
}

/** Observa cancelamento mesmo quando o transporte ignora AbortSignal. */
export async function abortable<T>(
	promise: Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	if (!signal) return promise;
	signal.throwIfAborted();
	let stop!: () => void;
	const aborted = new Promise<never>((_, reject) => {
		stop = () =>
			reject(signal.reason ?? new DOMException("Cancelled", "AbortError"));
		signal.addEventListener("abort", stop, { once: true });
	});
	try {
		return await Promise.race([promise, aborted]);
	} finally {
		signal.removeEventListener("abort", stop);
	}
}

export function createDecisionBudget(options: DecisionBudgetOptions) {
	const timeouts = readDecisionTimeouts(options);
	if (
		options.deadlineAtMs !== undefined &&
		(!Number.isFinite(options.deadlineAtMs) || options.deadlineAtMs < 0)
	)
		throw new RangeError("Invalid deadlineAtMs");
	const controller = new AbortController();
	const remainingMs = Math.min(
		timeouts.totalMs,
		(options.deadlineAtMs ?? Infinity) - Date.now(),
	);
	const expire = () =>
		controller.abort(
			new DOMException("Decision deadline exceeded", "TimeoutError"),
		);
	if (remainingMs <= 0) expire();
	let timer = remainingMs > 0 ? setTimeout(expire, remainingMs) : undefined;
	const startedAt = Date.now();
	const progressMs =
		options.progressTimeoutMs === undefined
			? timeouts.totalMs
			: duration(options.progressTimeoutMs, timeouts.totalMs, "progressTimeoutMs");
	let extended = false;
	/** 1º sinal de vida: ergue o teto total para `progressTimeoutMs` (limitado pelo prazo do run). */
	const extendOnProgress = () => {
		if (extended || !timer || progressMs <= timeouts.totalMs) return;
		extended = true;
		const next = Math.min(
			progressMs - (Date.now() - startedAt),
			(options.deadlineAtMs ?? Infinity) - Date.now(),
		);
		clearTimeout(timer);
		if (next <= 0) expire();
		else timer = setTimeout(expire, next);
	};
	const signal = options.signal
		? AbortSignal.any([options.signal, controller.signal])
		: controller.signal;
	return {
		signal,
		timeouts,
		dispose: () => {
			if (timer) clearTimeout(timer);
		},
		attempt() {
			const attemptController = new AbortController();
			const attemptSignal = AbortSignal.any([signal, attemptController.signal]);
			const timeout = () =>
				attemptController.abort(
					new DOMException("First event or idle timeout", "TimeoutError"),
				);
			let useful = false;
			let watchdog = setTimeout(timeout, timeouts.firstMs);
			return {
				signal: attemptSignal,
				markUseful() {
					useful = true;
					extendOnProgress();
					clearTimeout(watchdog);
					watchdog = setTimeout(timeout, timeouts.idleMs);
				},
				dispose() {
					clearTimeout(watchdog);
				},
				hasUseful: () => useful,
			};
		},
	};
}
