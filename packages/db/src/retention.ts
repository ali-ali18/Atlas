import { prisma } from "./client.js";

/**
 * Retenção diária (worker, horário calmo):
 * - `run_events` de runs ENCERRADOS há mais de 30 dias: apaga, menos os tipos que a UI ainda lê de um run
 *   antigo (inspetor, revisão de lições, histórico da sessão de código, fim/erro). A linha do run fica
 *   (status, resultado, erro).
 * - `routine_runs`: guarda as 50 execuções mais recentes de cada rotina (nunca apaga uma em andamento).
 * - Mensagens da conversa NUNCA são apagadas aqui.
 * Tudo em lotes pequenos (SELECT de ids + DELETE por id) para não segurar trava longa nas tabelas.
 */
export const RUN_EVENTS_RETENTION_DAYS = 30;
export const ROUTINE_RUNS_KEEP = 50;
export const RETENTION_BATCH = 1_000;

/** Run encerrado: não volta a gravar evento. `paused`/`waiting_*` não entram (ainda podem continuar). */
export const RETENTION_TERMINAL_RUN_STATUSES = ["completed", "failed", "cancelled", "budget_exhausted"] as const;

/**
 * Tipos de evento que sobrevivem à retenção, por quem lê de um run já encerrado:
 * - inspetor do run (`run-inspect.ts`): inspect_context, inspect_lessons, inspect_hooks, error;
 * - revisão de lições (`lesson-review-data.ts`): lesson_review;
 * - histórico e contadores da sessão de código (`dev-sessions.ts`), menos a saída bruta dos comandos;
 * - fim do run: done.
 * A conversa não depende deles: cards e falas são mensagens próprias, e a web só relê eventos de run vivo.
 */
export const RETAINED_RUN_EVENT_TYPES = [
	"inspect_context",
	"inspect_lessons",
	"inspect_hooks",
	"error",
	"done",
	"lesson_review",
	"dev_session_status",
	"dev_setup_step",
	"shell_started",
	"shell_done",
	"file_edit",
	"todo_updated",
	"dev_pr",
	"dev_ci",
	"context_compacted",
	"context_usage",
	"dev_timing",
] as const;

/** Execuções de rotina que ainda podem mudar: nunca apagadas, mesmo além das 50. */
const ACTIVE_ROUTINE_RUN_STATUSES = ["queued", "running"];

export type RetentionPlan = { runEventsBefore: Date; routineRunsKeep: number };

/** Decisão pura: o corte das duas limpezas a partir de `now`. */
export function planRetention(now: Date, options: { runEventsDays?: number; routineRunsKeep?: number } = {}): RetentionPlan {
	const days = options.runEventsDays ?? RUN_EVENTS_RETENTION_DAYS;
	return {
		runEventsBefore: new Date(now.getTime() - days * 24 * 60 * 60 * 1000),
		routineRunsKeep: options.routineRunsKeep ?? ROUTINE_RUNS_KEEP,
	};
}

type BatchOptions = { batchSize?: number; maxBatches?: number; pause?: () => Promise<void> };

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 25));

/** Apaga eventos de runs encerrados antes do corte (menos os tipos retidos). Devolve quantos apagou. */
export async function pruneOldRunEvents(before: Date, options: BatchOptions = {}): Promise<number> {
	const batchSize = options.batchSize ?? RETENTION_BATCH;
	const maxBatches = options.maxBatches ?? 500;
	const pause = options.pause ?? tick;
	let deleted = 0;
	let batches = 0;
	let cursor: string | undefined;
	while (batches < maxBatches) {
		const runs = await prisma.agentRun.findMany({
			where: { status: { in: [...RETENTION_TERMINAL_RUN_STATUSES] }, finishedAt: { lt: before } },
			orderBy: { id: "asc" },
			take: 200,
			...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
			select: { id: true },
		});
		if (runs.length === 0) break;
		cursor = runs[runs.length - 1]!.id;
		const runIds = runs.map((run) => run.id);
		for (;;) {
			const rows = await prisma.runEvent.findMany({
				where: { runId: { in: runIds }, type: { notIn: [...RETAINED_RUN_EVENT_TYPES] } },
				take: batchSize,
				select: { id: true },
			});
			if (rows.length === 0) break;
			const result = await prisma.runEvent.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
			deleted += result.count;
			batches += 1;
			if (rows.length < batchSize || batches >= maxBatches) break;
			await pause();
		}
		if (runs.length < 200) break;
	}
	return deleted;
}

/** Guarda só as `keep` execuções mais recentes de cada rotina (as em andamento ficam sempre). */
export async function pruneRoutineRuns(keep: number, options: BatchOptions = {}): Promise<number> {
	const batchSize = options.batchSize ?? RETENTION_BATCH;
	const pause = options.pause ?? tick;
	let deleted = 0;
	let cursor: string | undefined;
	for (;;) {
		const routines = await prisma.routine.findMany({
			orderBy: { id: "asc" },
			take: 200,
			...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
			select: { id: true },
		});
		if (routines.length === 0) break;
		cursor = routines[routines.length - 1]!.id;
		for (const routine of routines) {
			for (;;) {
				const older = await prisma.routineRun.findMany({
					where: { routineId: routine.id },
					orderBy: [{ createdAt: "desc" }, { id: "desc" }],
					skip: keep,
					take: batchSize,
					select: { id: true, status: true },
				});
				const ids = older.filter((row) => !ACTIVE_ROUTINE_RUN_STATUSES.includes(row.status)).map((row) => row.id);
				if (ids.length > 0) {
					const result = await prisma.routineRun.deleteMany({ where: { id: { in: ids }, routineId: routine.id } });
					deleted += result.count;
				}
				// Lote cheio só de execuções ativas: nada mais a apagar nesta rotina por agora.
				if (older.length < batchSize || ids.length === 0) break;
				await pause();
			}
		}
		if (routines.length < 200) break;
	}
	return deleted;
}

export type RetentionResult = { runEvents: number; routineRuns: number };

/** Passo diário completo. Cada parte falha sozinha (a outra ainda roda); o erro sobe depois para o job registrar. */
export async function runDataRetention(now: Date = new Date(), options: BatchOptions = {}): Promise<RetentionResult> {
	const plan = planRetention(now);
	const errors: unknown[] = [];
	const runEvents = await pruneOldRunEvents(plan.runEventsBefore, options).catch((error) => (errors.push(error), 0));
	const routineRuns = await pruneRoutineRuns(plan.routineRunsKeep, options).catch((error) => (errors.push(error), 0));
	if (errors.length > 0) throw errors[0];
	return { runEvents, routineRuns };
}
