/**
 * Dá um prazo a uma promessa: se `ms` passar sem resposta, rejeita com o erro de `onTimeout` (e o resultado tardio é
 * ignorado). Usado no pedido do link da tela, para a tela nunca ficar em "Conectando" para sempre se a rede travar.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(onTimeout()), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}
