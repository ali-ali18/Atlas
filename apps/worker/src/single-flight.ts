/**
 * Uma execução por vez, sem perder gatilhos: chamada durante uma execução em andamento não é descartada, mas
 * enfileira UMA passada de acompanhamento (várias chamadas viram uma). Devolve a soma dos resultados da cadeia.
 * `task` não deve lançar; se lançar, a cadeia termina e a próxima chamada começa do zero.
 */
export function singleFlight(task: () => Promise<number>): () => Promise<number> {
	let inflight: Promise<number> | null = null;
	let again = false;
	const loop = async (): Promise<number> => {
		let total = 0;
		try {
			for (;;) {
				again = false;
				total += await task();
				if (!again) return total;
			}
		} finally {
			inflight = null;
		}
	};
	return () => {
		if (inflight) {
			again = true;
			return inflight;
		}
		inflight = loop();
		return inflight;
	};
}
