// Limite de tempo para um pedido ao servidor: a tela nunca fica girando para sempre por causa de uma parte lenta
// (o Composio e o catálogo remoto de bots dependem de serviços de fora). Puro, testado em with-timeout.test.ts.

/** Erro de tempo esgotado (a tela trata como falha comum, com "Tentar de novo"). */
export class TimeoutError extends Error {
	constructor() {
		super("Tempo esgotado.");
		this.name = "TimeoutError";
	}
}

/** Rejeita com `TimeoutError` se `promise` não terminar em `ms`. `schedule` é injetável para teste. */
export function withTimeout<T>(promise: Promise<T>, ms: number, schedule: (run: () => void, ms: number) => () => void = defaultSchedule): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let done = false;
		const cancel = schedule(() => {
			if (done) return;
			done = true;
			reject(new TimeoutError());
		}, ms);
		promise.then(
			(value) => {
				if (done) return;
				done = true;
				cancel();
				resolve(value);
			},
			(reason) => {
				if (done) return;
				done = true;
				cancel();
				reject(reason);
			},
		);
	});
}

function defaultSchedule(run: () => void, ms: number): () => void {
	const timer = setTimeout(run, ms);
	return () => clearTimeout(timer);
}
