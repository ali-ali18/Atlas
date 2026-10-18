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
	const remaining = Math.min(
		timeoutMs ?? Infinity,
		context.deadlineAtMs === undefined
			? Infinity
			: context.deadlineAtMs - Date.now(),
	);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let abortListener: (() => void) | undefined;
	const interrupted = new Promise<never>((_, reject) => {
		const abort = (reason: "cancel" | "deadline") => {
			const error = new SandboxExecutionAbortedError(reason);
			controller.abort(
				reason === "cancel" ? (context.signal?.reason ?? error) : error,
			);
			reject(error);
		};
		abortListener = () => abort("cancel");
		context.signal?.addEventListener("abort", abortListener, { once: true });
		if (Number.isFinite(remaining))
			timer = setTimeout(() => abort("deadline"), Math.max(0, remaining));
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
		delayMs + 1,
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
