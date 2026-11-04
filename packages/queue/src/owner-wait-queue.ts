import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import {
	ATLAS_JOB_NAMES,
	ATLAS_QUEUE_NAMES,
	ownerWaitTimeoutJobId,
	scheduledReturnJobId,
	type OwnerWaitJobPayload,
	type OwnerWaitJobResult,
	type OwnerWaitTimeoutJobPayload,
	type ScheduledReturnJobPayload,
} from "@workspace/shared";
import { propagateRequestId } from "./request-id.js";

export const OWNER_WAIT_QUEUE_NAME = ATLAS_QUEUE_NAMES.ownerWait;

export type OwnerWaitJobName = typeof ATLAS_JOB_NAMES.ownerWaitTimeout | typeof ATLAS_JOB_NAMES.scheduledReturn;

/**
 * Fila do "esperar o dono" do motor v3: prazo do cartão (`waitMinutes`) e "Volto depois" (`schedule_return`).
 * Só jobs atrasados (custo zero esperando, sem polling). O jobId é determinístico: responder antes (ou cancelar o
 * retorno) remove o job, e o processador confere o estado no banco antes de agir (job que escapou vira no-op).
 */
export type OwnerWaitQueue = Pick<Queue<OwnerWaitJobPayload, OwnerWaitJobResult, OwnerWaitJobName>, "add" | "getJob">;

export function createOwnerWaitQueue(connection: Redis): Queue<OwnerWaitJobPayload, OwnerWaitJobResult, OwnerWaitJobName> {
	return propagateRequestId(
		new Queue<OwnerWaitJobPayload, OwnerWaitJobResult, OwnerWaitJobName>(OWNER_WAIT_QUEUE_NAME, {
			connection,
			defaultJobOptions: {
				removeOnComplete: 200,
				removeOnFail: 200,
				// Falha transitória (banco/Redis no deploy): mais duas tentativas; o processador é idempotente.
				attempts: 3,
				backoff: { type: "exponential", delay: 10_000 },
			},
		}),
	);
}

/** Agenda o prazo do cartão. Mesmo jobId = o mesmo cartão: o add repetido é ignorado pelo BullMQ. */
export async function scheduleOwnerWaitTimeout(queue: OwnerWaitQueue, payload: OwnerWaitTimeoutJobPayload): Promise<void> {
	await queue.add(ATLAS_JOB_NAMES.ownerWaitTimeout, payload, { jobId: ownerWaitTimeoutJobId(payload.cardId), delay: Math.max(0, payload.minutes * 60_000) });
}

/** O dono respondeu antes do prazo: tira o job da fila (sem job, nada a fazer). */
export async function cancelOwnerWaitTimeout(queue: OwnerWaitQueue, cardId: string): Promise<boolean> {
	const job = await queue.getJob(ownerWaitTimeoutJobId(cardId)).catch(() => null);
	if (!job) return false;
	return await job.remove().then(() => true, () => false);
}

export async function scheduleReturnJob(queue: OwnerWaitQueue, payload: ScheduledReturnJobPayload, delayMs: number): Promise<void> {
	await queue.add(ATLAS_JOB_NAMES.scheduledReturn, payload, { jobId: scheduledReturnJobId(payload.returnId), delay: Math.max(0, delayMs) });
}

export async function cancelReturnJob(queue: OwnerWaitQueue, returnId: string): Promise<boolean> {
	const job = await queue.getJob(scheduledReturnJobId(returnId)).catch(() => null);
	if (!job) return false;
	return await job.remove().then(() => true, () => false);
}
