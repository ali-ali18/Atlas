import type { AgentRunQueue } from "@workspace/queue";

/** A API apenas enfileira e inspeciona jobs; testes não precisam conectar Redis. */
export type RunQueue = {
	add: (...args: Parameters<AgentRunQueue["add"]>) => Promise<unknown>;
	getJob: (id: string) => Promise<{
		getState: () => Promise<string>;
		remove: () => Promise<unknown>;
	} | undefined>;
};
