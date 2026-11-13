// Porta `Queue`: o motor só enfileira trabalho (inclusive atrasado); quem
// consome é o worker. Atravessar turnos é sempre explícito (lembrete, vigia).

export type QueueJob = {
	name: string;
	userId: string;
	payload: unknown;
	/** Atraso em ms antes de o job ficar disponível. */
	delayMs?: number;
	/** Evita job duplicado ao reenfileirar (ex.: item de agenda). */
	dedupeKey?: string;
};

export interface Queue {
	enqueue(job: QueueJob): Promise<{ jobId: string }>;
	/** Cancela job ainda não executado; `false` se não existia. */
	cancel(userId: string, jobId: string): Promise<boolean>;
}
