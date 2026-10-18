import { AgentRunCancelledError, LeaseLostError } from "@workspace/agent-runtime";

/**
 * Deploy/SIGTERM: o worker vai sair e o passo atual não terminou dentro da
 * janela de graça. É um `LeaseLostError` de propósito: o processor já trata
 * esse caminho (marca o run "retrying" e solta o lease na hora), então o
 * próximo worker retoma sem esperar o lease vencer.
 */
export class WorkerShuttingDownError extends LeaseLostError {
	constructor() {
		super("Worker reiniciando; retomando em outro processo");
		this.name = "WorkerShuttingDownError";
	}
}

/**
 * F4 — um tick do heartbeat de lease. Renovação que devolve `false` OU que
 * lança vai pelo mesmo caminho: avisa `onLeaseLost` (o processor marca
 * `leaseLost` e aborta o run). Puro o suficiente para teste isolado.
 */
export async function tickLeaseHeartbeat(input: {
	renew: () => Promise<boolean>;
	onLeaseLost: (error: unknown) => void;
}): Promise<void> {
	try {
		const ok = await input.renew();
		if (!ok) {
			input.onLeaseLost(new LeaseLostError());
		}
	} catch (error) {
		input.onLeaseLost(error);
	}
}

export type LeaseGuards = {
	aborter: AbortController;
	isLeaseLost: () => boolean;
	/** Para os timers e aborta o sinal. Idempotente; chame no `finally`. */
	stop: () => void;
};

/**
 * Heartbeat do lease + poll de cancelamento de um run. Criados DENTRO do
 * try/finally do processor, logo depois de adquirir o lease: qualquer falha do
 * setup (ou do run) passa por `stop()`, sem timers zumbis renovando o lease de
 * um run que ninguém mais executa.
 */
export function startLeaseGuards(input: {
	runId: string;
	renew: () => Promise<boolean>;
	isCancelRequested: () => Promise<boolean>;
	extendLock?: () => Promise<void>;
	heartbeatMs?: number;
	cancelPollMs?: number;
	/**
	 * Sinais do run (Redis): `cancel` dispara a checagem na hora e a consulta periódica vira só
	 * segurança (`cancelFallbackPollMs`, 15 s). Ausente = consulta a cada `cancelPollMs`.
	 */
	subscribeSignals?: (onSignal: (kind: string) => void) => () => void;
	cancelFallbackPollMs?: number;
	/** Disparado no shutdown do worker: aborta o run com `WorkerShuttingDownError` (checkpoint + lease liberado). */
	shutdownSignal?: AbortSignal;
}): LeaseGuards {
	const { runId } = input;
	let leaseLost = false;
	const aborter = new AbortController();
	const checkCancel = () => {
		void input
			.isCancelRequested()
			.then((cancelled) => {
				if (cancelled && !aborter.signal.aborted) {
					aborter.abort(new AgentRunCancelledError());
				}
			})
			.catch(() => undefined);
	};
	const unsubscribeSignals = input.subscribeSignals?.((kind) => {
		if (kind === "cancel") checkCancel();
	});
	const onShutdown = () => {
		if (!aborter.signal.aborted) aborter.abort(new WorkerShuttingDownError());
	};
	if (input.shutdownSignal) {
		if (input.shutdownSignal.aborted) onShutdown();
		else input.shutdownSignal.addEventListener("abort", onShutdown, { once: true });
	}
	const cancelPoll = setInterval(
		checkCancel,
		unsubscribeSignals ? (input.cancelFallbackPollMs ?? 15_000) : (input.cancelPollMs ?? 2000),
	);
	// Cancelamento pedido entre o início do run e a inscrição não gera sinal: confere uma vez.
	if (unsubscribeSignals) checkCancel();
	const heartbeat = setInterval(() => {
		void Promise.all([
			// F4 — renovação que lança aborta igual ao `!ok` (antes só marcava).
			tickLeaseHeartbeat({
				renew: input.renew,
				onLeaseLost: (error) => {
					console.error(`lease renew failed run=${runId}`, error);
					leaseLost = true;
					if (!aborter.signal.aborted) {
						aborter.abort(
							error instanceof LeaseLostError ? error : new LeaseLostError(),
						);
					}
				},
			}),
			input.extendLock?.().catch((error) => {
				console.error(`job lock extend failed run=${runId}`, error);
			}),
		]);
	}, input.heartbeatMs ?? 10_000);
	return {
		aborter,
		isLeaseLost: () => leaseLost,
		stop: () => {
			clearInterval(heartbeat);
			clearInterval(cancelPoll);
			unsubscribeSignals?.();
			input.shutdownSignal?.removeEventListener("abort", onShutdown);
			aborter.abort();
		},
	};
}
