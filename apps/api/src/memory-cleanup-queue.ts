import { clearMemoryCleanupStatus, markMemoryCleanupGenerating } from "@workspace/db";
import type { MemoryCleanupJobPayload } from "@workspace/shared";

/**
 * Fila da limpeza de memória: a API só enfileira (o worker revisa com o Jev e o modelo de manutenção da conta e
 * grava SUGESTÕES). Sem fila (testes, Redis fora) o pedido recusa em vez de ficar "revisando" para sempre.
 */
export type MemoryCleanupEnqueuer = (payload: MemoryCleanupJobPayload, jobId: string) => Promise<unknown>;

let enqueuer: MemoryCleanupEnqueuer | null = null;

export function setMemoryCleanupEnqueuer(next: MemoryCleanupEnqueuer | null): void {
	enqueuer = next;
}

export function memoryCleanupQueueReady(): boolean {
	return enqueuer !== null;
}

/** Pedido assíncrono de revisão. O estado "revisando" é gravado antes (a UI o mostra; velho demais vira falha). */
export async function enqueueMemoryCleanup(payload: MemoryCleanupJobPayload): Promise<boolean> {
	if (!enqueuer) return false;
	await markMemoryCleanupGenerating(payload.userId, payload.botId).catch(() => false);
	try {
		await enqueuer(payload, `memory-cleanup-${payload.botId}-${Date.now()}`);
		return true;
	} catch (error) {
		console.error("enqueue memory cleanup failed", error instanceof Error ? error.name : "unknown");
		await clearMemoryCleanupStatus(payload.userId, payload.botId).catch(() => false);
		return false;
	}
}
