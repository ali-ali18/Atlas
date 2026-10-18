import { Queue } from "bullmq";
import { propagateRequestId } from "./request-id.js";
import type { Redis } from "ioredis";
import {
	ATLAS_JOB_NAMES,
	ATLAS_QUEUE_NAMES,
	planOnceRoutine,
	type ExecuteRoutineJobPayload,
	type ExecuteRoutineJobResult,
	type EventEnvelope,
	type RoutineRecord,
} from "@workspace/shared";

export const ROUTINE_QUEUE_NAME = ATLAS_QUEUE_NAMES.routines;
export const EXECUTE_ROUTINE_JOB_NAME = ATLAS_JOB_NAMES.executeRoutine;

export type RoutineQueue = Queue<
	ExecuteRoutineJobPayload,
	ExecuteRoutineJobResult,
	string
>;

/**
 * Uma nova tentativa com espera curta: absorve queda de Redis/DB/deploy no meio do
 * disparo. Idempotente: o processor reaproveita a RoutineRun da 1ª tentativa
 * (ver `runRoutineJob`), então não cria execução duplicada.
 */
export const ROUTINE_JOB_RETRY = {
	attempts: 2,
	backoff: { type: "fixed" as const, delay: 20_000 },
};

export function createRoutineQueue(connection: Redis): RoutineQueue {
	return propagateRequestId(new Queue<
		ExecuteRoutineJobPayload,
		ExecuteRoutineJobResult,
		string
	>(ROUTINE_QUEUE_NAME, {
		connection,
		defaultJobOptions: {
			removeOnComplete: 100,
			removeOnFail: 200,
			...ROUTINE_JOB_RETRY,
		},
	}));
}

export function routineSchedulerId(routineId: string): string {
	return `routine:${routineId}`;
}

/**
 * jobId do job atrasado (delayed) de uma rotina `once`. BullMQ reserva ':'
 * em ids internos de job scheduler — aqui é um jobId normal (`queue.add`),
 * mas usa '-' por segurança/consistência com o resto do arquivo.
 */
export function routineOnceJobId(routineId: string): string {
	return `routine-once-${routineId}`;
}

async function scheduleOnceRoutineJob(
	queue: RoutineQueue,
	routineId: string,
	runAt: string,
	now: Date = new Date(),
): Promise<void> {
	const plan = planOnceRoutine(runAt, now);
	// "missed" não deveria acontecer aqui (create/update já validam o futuro
	// com folga) — se acontecer (ex.: relógio do processo atrasado), não
	// agenda; o reconcile de boot do worker cuida de limpar rotinas perdidas.
	if (plan.action === "missed") return;
	const jobId = routineOnceJobId(routineId);
	// Mesmo jobId: sem remover o job antigo, o BullMQ ignora o add e o
	// reagendamento (edição de run_at) nunca vale.
	await removeOnceRoutineJob(queue, routineId);
	await queue.add(
		EXECUTE_ROUTINE_JOB_NAME,
		{ routineId, triggeredBy: "schedule" },
		{ jobId, delay: plan.action === "run-now" ? 0 : plan.delayMs },
	);
}

export async function removeOnceRoutineJob(
	queue: RoutineQueue,
	routineId: string,
): Promise<void> {
	const job = await queue.getJob(routineOnceJobId(routineId)).catch(() => null);
	if (job) await job.remove().catch(() => undefined);
}

/**
 * Repetição do BullMQ para a rotina: cron usa `pattern`+`tz`; `interval` usa
 * `every` (ms decorridos, ao contrário de um cron de passo 50, que dispara em :00 e :50).
 * `null` = rotina sem repetição (event/once ou dados incompletos).
 */
export function routineRepeatOptions(
	routine: Pick<RoutineRecord, "schedule" | "timezone" | "triggerType" | "interval">,
): { pattern: string; tz: string } | { every: number } | null {
	if (routine.triggerType === "cron" && routine.schedule) {
		return { pattern: routine.schedule, tz: routine.timezone || "America/Sao_Paulo" };
	}
	if (routine.triggerType === "interval" && routine.interval?.everyMinutes) {
		return { every: routine.interval.everyMinutes * 60_000 };
	}
	return null;
}

export async function syncRoutineScheduler(
	queue: RoutineQueue,
	routine: Pick<
		RoutineRecord,
		"id" | "enabled" | "schedule" | "timezone" | "triggerType" | "once" | "interval"
	>,
): Promise<void> {
	const schedulerId = routineSchedulerId(routine.id);
	const repeat = routineRepeatOptions(routine);
	if (routine.enabled && repeat) {
		await queue.upsertJobScheduler(
			schedulerId,
			repeat,
			{
				name: EXECUTE_ROUTINE_JOB_NAME,
				data: {
					routineId: routine.id,
					triggeredBy: "schedule",
				},
				opts: { ...ROUTINE_JOB_RETRY },
			},
		);
		await removeOnceRoutineJob(queue, routine.id);
		return;
	}
	await queue.removeJobScheduler(schedulerId).catch(() => undefined);
	if (routine.triggerType === "once" && routine.enabled && routine.once?.runAt) {
		await scheduleOnceRoutineJob(queue, routine.id, routine.once.runAt);
	} else {
		await removeOnceRoutineJob(queue, routine.id);
	}
}

export async function removeRoutineScheduler(
	queue: RoutineQueue,
	routineId: string,
): Promise<void> {
	await queue.removeJobScheduler(routineSchedulerId(routineId)).catch(() => undefined);
	await removeOnceRoutineJob(queue, routineId);
}

export type OnceRoutineReconcileResult = {
	/** Rotinas `once` cujo horário passou de 1h — o caller apaga e avisa na conversa. */
	missed: Array<{ id: string }>;
};

/**
 * Reconcile de boot pra rotinas `once`: garante que toda rotina habilitada
 * com horário futuro (ou levemente atrasado) tenha um job atrasado
 * pendente — cobre o caso de Redis ter sido limpo/reiniciado entre a
 * criação da rotina e agora. Rotinas com mais de 1h de atraso voltam em
 * `missed` pro caller (worker) apagar a rotina e avisar na conversa — este
 * módulo não toca banco/mensagens.
 */
export async function reconcileOnceRoutines(
	queue: RoutineQueue,
	routines: Array<Pick<RoutineRecord, "id" | "enabled" | "once">>,
	now: Date = new Date(),
): Promise<OnceRoutineReconcileResult> {
	const missed: Array<{ id: string }> = [];
	for (const routine of routines) {
		if (!routine.enabled || !routine.once?.runAt) continue;
		const plan = planOnceRoutine(routine.once.runAt, now);
		if (plan.action === "missed") {
			missed.push({ id: routine.id });
			continue;
		}
		const existing = await queue.getJob(routineOnceJobId(routine.id)).catch(() => null);
		if (existing) continue;
		await scheduleOnceRoutineJob(queue, routine.id, routine.once.runAt, now);
	}
	return { missed };
}

export async function enqueueRoutineNow(
	queue: RoutineQueue,
	routineId: string,
): Promise<boolean> {
	try {
		await queue.add(
			EXECUTE_ROUTINE_JOB_NAME,
			{ routineId, triggeredBy: "manual" },
			{ jobId: `routine-now-${routineId}-${Date.now()}` },
		);
		return true;
	} catch (error) {
		console.error(`failed to enqueue routine now ${routineId}`, error);
		return false;
	}
}

/** Enfileira disparo por evento (webhook). AgentRun continua origin:"routine". */
export async function enqueueRoutineEvent(
	queue: RoutineQueue,
	input: {
		routineId: string;
		routineRunId: string;
		event: EventEnvelope;
	},
): Promise<boolean> {
	try {
		await queue.add(
			EXECUTE_ROUTINE_JOB_NAME,
			{
				routineId: input.routineId,
				routineRunId: input.routineRunId,
				triggeredBy: "event",
				event: input.event,
			},
			{ jobId: `routine-event-${input.routineRunId}` },
		);
		return true;
	} catch (error) {
		console.error(
			`failed to enqueue routine event ${input.routineId}`,
			error,
		);
		return false;
	}
}

function schedulerKey(entry: {
	id?: string | null;
	key?: string | null;
}): string | undefined {
	return entry.id ?? entry.key ?? undefined;
}

export async function rehydrateRoutineSchedulers(
	queue: RoutineQueue,
	routines: Array<
		Pick<
			RoutineRecord,
			"id" | "enabled" | "schedule" | "timezone" | "triggerType" | "interval"
		>
	>,
): Promise<void> {
	const desired = new Set(
		routines
			.filter((routine) => routine.enabled && routineRepeatOptions(routine))
			.map((routine) => routineSchedulerId(routine.id)),
	);
	const existing = await queue.getJobSchedulers(0, 1000);
	for (const scheduler of existing) {
		const key = schedulerKey(scheduler);
		if (!key || !key.startsWith("routine:")) continue;
		if (!desired.has(key)) {
			await queue.removeJobScheduler(key).catch(() => undefined);
		}
	}
	for (const routine of routines) {
		await syncRoutineScheduler(queue, routine);
	}
}

/**
 * Re-enfileira um disparo por evento com atraso (bot ocupado). jobId novo por
 * adiamento (`routine-event-<run>-defer-<n>`): o BullMQ ignora `add` com o
 * jobId do job que ainda está ativo. Mantém a RoutineRun "queued".
 */
export async function enqueueRoutineEventDeferred(
	queue: RoutineQueue,
	payload: ExecuteRoutineJobPayload & { routineRunId: string },
	delayMs: number,
): Promise<void> {
	await queue.add(EXECUTE_ROUTINE_JOB_NAME, payload, {
		jobId: `routine-event-${payload.routineRunId}-defer-${payload.deferrals ?? 1}`,
		delay: Math.max(0, Math.round(delayMs)),
	});
}
