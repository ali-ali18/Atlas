/**
 * Fila de envios feitos enquanto o envio anterior ainda cria o run (ainda não há run para receber a fala
 * como input). O composer limpa o texto ao enviar, então descartar a segunda mensagem a perderia. Entrega na
 * ordem em que foram digitadas, uma de cada vez, quando o run existe (ou quando a criação falhou).
 */
export function createSendQueue<T>() {
	let items: T[] = [];
	let chain: Promise<void> = Promise.resolve();
	return {
		push(item: T) {
			items.push(item);
		},
		get size() {
			return items.length;
		},
		/** Troca de conversa: o que estava na fila era da conversa anterior. */
		clear() {
			items = [];
		},
		/** Entrega o que está na fila na ordem; chamadas seguidas encadeiam (nunca duas ao mesmo tempo). */
		flush(send: (item: T) => Promise<void>): Promise<void> {
			const batch = items;
			items = [];
			if (batch.length === 0) return chain;
			chain = chain.then(async () => {
				for (const item of batch) {
					try {
						await send(item);
					} catch {
						// o erro de cada envio já é mostrado por quem envia
					}
				}
			});
			return chain;
		},
	};
}
