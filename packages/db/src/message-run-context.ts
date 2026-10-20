import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Run em execução no contexto assíncrono atual. As falas do assistente e os cartões que um run grava na
 * conversa ganham `runId` sem que cada ponto de gravação (dezenas, dentro do runtime) precise receber o id.
 * Fora de um run (API, rotas) não há contexto e a mensagem fica sem `runId`.
 */
const store = new AsyncLocalStorage<string>();

export function withMessageRunId<T>(runId: string, fn: () => Promise<T>): Promise<T> {
	return store.run(runId, fn);
}

export function currentMessageRunId(): string | undefined {
	return store.getStore();
}
