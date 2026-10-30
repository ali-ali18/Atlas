/** Prazo absoluto compartilhado entre init, transporte e leitura da resposta. */
export type SandboxExecutionContext = {
	signal?: AbortSignal;
	deadlineAtMs?: number;
	/** V8: aba do navegador que as ações deste contexto usam (subagente). Sem ela, a página do pai. */
	tabId?: string;
};

export class SandboxExecutionAbortedError extends Error {
	readonly externalOperationMayContinue = true;
	constructor(readonly reason: "cancel" | "deadline") {
		super(
			reason === "cancel"
				? "Sandbox execution cancelled"
				: "Sandbox execution deadline exceeded",
		);
		this.name = "SandboxExecutionAbortedError";
	}
}

/** Teto próprio de uma chamada estourou. Não é o prazo do run: quem chama pode tentar de novo. */
export class SandboxOperationTimeoutError extends Error {
	constructor(readonly timeoutMs: number) {
		super(`Sandbox operation timed out after ${timeoutMs}ms`);
		this.name = "SandboxOperationTimeoutError";
	}
}

export function assertSandboxExecution(
	context: SandboxExecutionContext = {},
): void {
	if (context.signal?.aborted) throw new SandboxExecutionAbortedError("cancel");
	if (
		context.deadlineAtMs !== undefined &&
		(!Number.isFinite(context.deadlineAtMs) ||
			Date.now() >= context.deadlineAtMs)
	) {
		throw new SandboxExecutionAbortedError("deadline");
	}
}

/** Observa cancelamento mesmo quando o SDK externo não coopera. Não desfaz efeitos. */
export async function runSandboxOperation<T>(
	context: SandboxExecutionContext,
	timeoutMs: number | undefined,
	operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	assertSandboxExecution(context);
	const controller = new AbortController();
	const deadlineRemaining =
		context.deadlineAtMs === undefined
			? Infinity
			: context.deadlineAtMs - Date.now();
	const remaining = Math.min(timeoutMs ?? Infinity, deadlineRemaining);
	// Só o prazo do contexto vira "deadline"; o teto da própria chamada é outro erro.
	const selfTimeout = timeoutMs !== undefined && timeoutMs < deadlineRemaining;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let abortListener: (() => void) | undefined;
	const interrupted = new Promise<never>((_, reject) => {
		const abort = (reason: "cancel" | "deadline" | "timeout") => {
			const error =
				reason === "timeout"
					? new SandboxOperationTimeoutError(timeoutMs ?? 0)
					: new SandboxExecutionAbortedError(reason);
			controller.abort(
				reason === "cancel" ? (context.signal?.reason ?? error) : error,
			);
			reject(error);
		};
		abortListener = () => abort("cancel");
		context.signal?.addEventListener("abort", abortListener, { once: true });
		if (Number.isFinite(remaining))
			timer = setTimeout(
				() => abort(selfTimeout ? "timeout" : "deadline"),
				Math.max(0, remaining),
			);
	});
	try {
		return await Promise.race([interrupted, operation(controller.signal)]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		if (abortListener)
			context.signal?.removeEventListener("abort", abortListener);
	}
}

export async function sleepSandbox(
	context: SandboxExecutionContext,
	delayMs: number,
): Promise<void> {
	await runSandboxOperation(
		context,
		// Sem teto próprio: só cancelamento/prazo do contexto interrompem a espera.
		undefined,
		(signal) =>
			new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => {
					signal.removeEventListener("abort", onAbort);
					resolve();
				}, delayMs);
				function onAbort() {
					clearTimeout(timer);
					reject(signal.reason);
				}
				signal.addEventListener("abort", onAbort, { once: true });
			}),
	);
}
