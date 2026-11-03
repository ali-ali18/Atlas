// Exclusão mútua POR ABA para o que numera ou lê refs (snapshot, read, act). Sem isto, um snapshot
// completo apaga e renumera os `data-atlas-ref` no meio de um clique em andamento (ou de outro
// snapshot concorrente) e o ref do modelo passa a apontar para outro elemento.
// Abas diferentes não se bloqueiam; erro de uma tarefa nunca trava a fila.
const tails = new WeakMap();

export function runExclusive(page, task) {
	const previous = tails.get(page) ?? Promise.resolve();
	const run = previous.then(task, task);
	const tail = run.then(() => undefined, () => undefined);
	tails.set(page, tail);
	return run;
}
