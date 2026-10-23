import { runDataRetention, type RetentionResult } from "@workspace/db";
import type { ChatCompletionQueue } from "@workspace/queue";
import { ATLAS_JOB_NAMES } from "@workspace/shared";

/**
 * Um agendamento só (id fixo = nome do job, como a fila tipa): vários workers fazem upsert do mesmo e o
 * BullMQ roda uma vez por dia.
 */
export const DATA_RETENTION_SCHEDULER_ID = ATLAS_JOB_NAMES.dataRetention;
/** Madrugada no fuso do produto, fora de minuto redondo (menos disputa com outros agendamentos). */
export const DATA_RETENTION_REPEAT = { pattern: "17 4 * * *", tz: "America/Sao_Paulo" } as const;

/** O que o agendamento usa da fila (injetável em teste); a fila de chat do BullMQ serve. */
type SchedulerQueue = Pick<ChatCompletionQueue, "upsertJobScheduler">;

export async function scheduleDataRetention(queue: SchedulerQueue): Promise<void> {
	await queue.upsertJobScheduler(DATA_RETENTION_SCHEDULER_ID, { ...DATA_RETENTION_REPEAT }, {
		name: ATLAS_JOB_NAMES.dataRetention,
		data: {},
		opts: { attempts: 1, removeOnComplete: 7, removeOnFail: 7 },
	});
}

/** Processador do job: limpa e registra só contagens. */
export async function processDataRetention(run: (now: Date) => Promise<RetentionResult> = runDataRetention, now = new Date()): Promise<RetentionResult> {
	const result = await run(now);
	console.log(`[retention] run_events apagados=${result.runEvents} routine_runs apagadas=${result.routineRuns}`);
	return result;
}
