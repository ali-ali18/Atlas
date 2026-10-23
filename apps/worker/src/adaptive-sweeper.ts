/**
 * Varredura periódica que se ajusta ao trabalho: com algo em andamento volta logo (`busyMs`), parada espera
 * `idleMs`. Trabalho novo chega por `kick` (gancho no processo, aviso do Redis, fim de run), que roda já.
 * Um passo por vez (sem sobreposição); pedido de passo durante outro roda de novo ao terminar. Nunca lança.
 */
export type AdaptiveSweeper = { kick: () => void; stop: () => void };

export function startAdaptiveSweeper<R extends { inFlight: boolean }>(options: {
	name: string;
	step: () => Promise<R>;
	onResult?: (result: R) => void;
	busyMs: number;
	idleMs: number;
	/** Fontes de "rode já"; cada uma devolve o unsubscribe. */
	triggers?: Array<(kick: () => void) => () => void>;
}): AdaptiveSweeper {
	let running = false;
	let again = false;
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | null = null;

	const schedule = (ms: number) => {
		if (stopped) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(kick, ms);
		timer.unref?.();
	};

	const sweep = async (): Promise<void> => {
		if (running) {
			again = true;
			return;
		}
		running = true;
		if (timer) clearTimeout(timer);
		timer = null;
		let inFlight = true;
		try {
			do {
				again = false;
				const result = await options.step();
				inFlight = result.inFlight;
				options.onResult?.(result);
			} while (again && !stopped);
		} catch (error) {
			console.error(`[${options.name}] sweep failed`, error);
			inFlight = true;
		} finally {
			running = false;
			schedule(inFlight ? options.busyMs : options.idleMs);
		}
	};

	function kick(): void {
		if (stopped) return;
		void sweep();
	}

	schedule(options.busyMs);
	const unsubscribers = (options.triggers ?? []).map((trigger) => trigger(kick));
	return {
		kick,
		stop: () => {
			stopped = true;
			if (timer) clearTimeout(timer);
			timer = null;
			for (const unsubscribe of unsubscribers) unsubscribe();
		},
	};
}
