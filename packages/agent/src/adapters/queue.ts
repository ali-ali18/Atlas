// Adaptador da porta `Queue` sobre um objeto com a forma de uma fila BullMQ (`add`/`getJob`). O worker injeta a fila
// real de `packages/queue`; o teste injeta uma falsa. O job leva o dono em `data.userId` e `cancel` só remove job do
// próprio dono (id de outro dono = `false`, igual a "não existe").
import { createHash } from "node:crypto";
import type { Queue, QueueJob } from "../ports/queue.js";

/** O mínimo que o adaptador usa de uma fila BullMQ. */
export type BullLikeQueue = {
	add(name: string, data: { userId: string; payload: unknown }, options?: { delay?: number; jobId?: string }): Promise<{ id?: string | undefined }>;
	getJob(jobId: string): Promise<{ data: unknown; remove(): Promise<unknown> } | null | undefined>;
};

/** 1 ano: atraso maior que isso é erro de unidade, não agenda. */
export const MAX_QUEUE_DELAY_MS = 365 * 24 * 60 * 60 * 1000;

/** Id de job estável por (dono, chave): o BullMQ não aceita `:` e a chave de um dono não pode colidir com a de outro. */
export function dedupeJobId(userId: string, dedupeKey: string): string {
	return `v4_${createHash("sha256").update(`${userId}\0${dedupeKey}`).digest("hex").slice(0, 40)}`;
}

export function createQueueAdapter(queue: BullLikeQueue): Queue {
	return {
		async enqueue(job: QueueJob) {
			if (!job.userId.trim() || job.userId === "default") throw new Error("Cannot schedule: this request has no valid owner.");
			if (!job.name.trim()) throw new Error("Cannot schedule: the item has no name.");
			if (job.delayMs !== undefined && (!Number.isFinite(job.delayMs) || job.delayMs < 0 || job.delayMs > MAX_QUEUE_DELAY_MS)) {
				throw new RangeError("Cannot schedule: the delay must be between 0 and 1 year.");
			}
			const jobId = job.dedupeKey ? dedupeJobId(job.userId, job.dedupeKey) : undefined;
			const added = await queue.add(job.name, { userId: job.userId, payload: job.payload }, {
				...(job.delayMs !== undefined && { delay: Math.round(job.delayMs) }),
				...(jobId && { jobId }),
			});
			if (!added.id) throw new Error("Scheduling was not confirmed, so the item may not be saved. Do not tell the owner it was scheduled.");
			return { jobId: String(added.id) };
		},
		async cancel(userId, jobId) {
			const job = await queue.getJob(jobId);
			const data = job?.data;
			const owner = typeof data === "object" && data !== null ? (data as { userId?: unknown }).userId : undefined;
			if (!job || owner !== userId) return false;
			await job.remove();
			return true;
		},
	};
}
