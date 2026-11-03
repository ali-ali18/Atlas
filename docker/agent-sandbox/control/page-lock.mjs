// Exclusão mútua POR ABA para o que numera ou lê refs (snapshot, read, act). Sem isto, um snapshot
// completo apaga e renumera os `data-atlas-ref` no meio de um clique em andamento (ou de outro
// snapshot concorrente) e o ref do modelo passa a apontar para outro elemento.
// Abas diferentes não se bloqueiam; erro de uma tarefa nunca trava a fila.
const tails = new WeakMap();

/** Teto por tarefa na fila: uma tarefa pendurada não trava a aba para sempre. */
export const TASK_TIMEOUT_MS = 60_000;

export function runExclusive(page, task, { timeoutMs = TASK_TIMEOUT_MS } = {}) {
	const previous = tails.get(page) ?? Promise.resolve();
	// O teto conta só a partir do início da tarefa (não da espera na fila). Ao estourar, a fila segue e a
	// pendurada recebe erro honesto; o resultado tardio dela é descartado.
	const bounded = previous.then(() => new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`A aba ficou ocupada por mais de ${Math.round(timeoutMs / 1000)} s; a operação foi abandonada para liberar a fila. Tente de novo.`)), timeoutMs);
		Promise.resolve().then(task).then(resolve, reject).finally(() => clearTimeout(timer));
	}));
	tails.set(page, bounded.then(() => undefined, () => undefined));
	return bounded;
}
