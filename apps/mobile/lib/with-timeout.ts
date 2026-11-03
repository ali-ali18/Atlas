/** A operação passou do tempo combinado. */
export class TimeoutError extends Error {
	constructor(readonly ms: number) {
		super("Tempo esgotado");
	}
}

/**
 * Rejeita com `TimeoutError` se `promise` não terminar em `ms`; ao estourar chama `onTimeout` (por exemplo
 * `controller.abort()`, para a rede parar de verdade). O resultado ou erro de `promise` vale se vier antes.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			onTimeout?.();
			reject(new TimeoutError(ms));
		}, ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}
