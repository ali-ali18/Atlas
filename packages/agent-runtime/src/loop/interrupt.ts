/**
 * `interrupt` (PLANO-RUN-V2 §6): ação explícita do usuário. Aborta a chamada ao
 * modelo em voo, descarta a resposta parcial e deixa o laço processar a entrada
 * como redirect no próximo passo.
 */

export const INTERRUPT_POLL_MS = 750;

/** Consulta de segurança quando há fonte de sinais: cobre mensagem perdida (Redis caiu/reconectou). */
export const SIGNAL_FALLBACK_POLL_MS = 15_000;

/**
 * Fonte de sinais do run (Redis pub/sub no worker), injetada pelo chamador: o
 * runtime não conhece Redis. Devolve o `unsubscribe`. Só `"input"` acorda os
 * vigias daqui; os demais tipos são ignorados.
 */
export type RunSignalSubscribe = (onSignal: (kind: string) => void) => () => void;

/**
 * Vigia sem sobreposição: um ciclo por vez, erro de um ciclo não derruba o
 * seguinte. Sem `subscribe`, consulta a cada `pollMs` (comportamento antigo).
 * Com `subscribe`, roda o ciclo quando chega um sinal `input` (se já havia um
 * ciclo em voo, roda de novo ao terminar, pois ele pode ter lido antes da
 * novidade) e só consulta por intervalo a cada `fallbackPollMs`.
 * `stop` limpa timer e inscrição (idempotente) e espera o ciclo em voo.
 * Compartilhado por `runInterruptible` e pela triagem ao vivo.
 */
export function startSignalWatch(
	task: () => Promise<void>,
	options: {
		subscribe?: RunSignalSubscribe;
		pollMs?: number;
		fallbackPollMs?: number;
		/** Com sinais: roda um ciclo ao iniciar (cobre novidade anterior à inscrição). */
		immediate?: boolean;
	} = {},
): { stop: () => Promise<void> } {
	let running: Promise<void> | null = null;
	let again = false;
	let stopped = false;
	const fire = (rerunIfBusy: boolean) => {
		if (stopped) return;
		if (running) {
			if (rerunIfBusy) again = true;
			return;
		}
		running = task()
			.catch(() => undefined)
			.finally(() => {
				running = null;
				if (again) {
					again = false;
					fire(false);
				}
			});
	};
	const unsubscribe = options.subscribe?.((kind) => {
		if (kind === "input") fire(true);
	});
	const timer = setInterval(
		() => fire(false),
		unsubscribe ? (options.fallbackPollMs ?? SIGNAL_FALLBACK_POLL_MS) : (options.pollMs ?? INTERRUPT_POLL_MS),
	);
	if (unsubscribe && options.immediate) fire(false);
	return {
		stop: async () => {
			stopped = true;
			clearInterval(timer);
			unsubscribe?.();
			while (running) await running;
		},
	};
}

/** Consulta periódica pura (sem sinais). Atalho de `startSignalWatch`. */
export function startPolling(task: () => Promise<void>, pollMs = INTERRUPT_POLL_MS): { stop: () => Promise<void> } {
	return startSignalWatch(task, { pollMs });
}

export class InterruptedByInputError extends Error {
	constructor() {
		super("Chamada ao modelo interrompida por uma nova entrada do usuário");
		this.name = "InterruptedByInputError";
	}
}

/**
 * Roda `run` com um sinal que também aborta quando `peek` acusa um interrupt novo.
 * Se isso acontecer, o resultado (mesmo que tenha chegado) é descartado e lança
 * `InterruptedByInputError`. Cancelamento do run segue como erro original.
 */
export async function runInterruptible<T>(
	options: {
		signal?: AbortSignal;
		peek?: () => Promise<boolean>;
		pollMs?: number;
		/** Fonte de sinais: troca a consulta de 750 ms por "consulta quando avisam" + segurança de 15 s. */
		subscribe?: RunSignalSubscribe;
		fallbackPollMs?: number;
	},
	run: (signal: AbortSignal | undefined) => Promise<T>,
): Promise<T> {
	const { peek } = options;
	if (!peek) return run(options.signal);

	const controller = new AbortController();
	const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
	let interrupted = false;
	const check = async () => {
		if (interrupted) return;
		try {
			if (await peek()) {
				interrupted = true;
				controller.abort();
			}
		} catch {
			// consulta falhou: a chamada segue; o próximo ciclo tenta de novo
		}
	};
	const poller = startSignalWatch(check, {
		subscribe: options.subscribe,
		pollMs: options.pollMs,
		fallbackPollMs: options.fallbackPollMs,
	});
	try {
		await check();
		if (interrupted) throw new InterruptedByInputError();
		const result = await run(signal);
		if (interrupted) throw new InterruptedByInputError();
		return result;
	} catch (error) {
		if (interrupted) throw new InterruptedByInputError();
		throw error;
	} finally {
		void poller.stop();
	}
}
