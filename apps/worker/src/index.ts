// Fase 0: dotenv ANTES de qualquer outro import — imports são hoisted e o
// @workspace/db valida ATLAS_HOOK_PEPPER no top-level.
import "dotenv/config";
import { closeSharedMcpPool, shutdownSharedExtractor } from "@workspace/agent-runtime";
import { DelayedError, UnrecoverableError, Worker, type Job } from "bullmq";
import { createActiveTracker, drainAgentWork } from "./shutdown.js";
import { WorkerShuttingDownError } from "./lease-guards.js";
import { randomUUID } from "node:crypto";
import {
	ATLAS_JOB_NAMES,
	type AgentRunJobPayload,
	type AgentRunJobResult,
	type ChatCompletionJobPayload,
	type ChatCompletionJobResult,
	type ExecuteRoutineJobPayload,
	type ExecuteRoutineJobResult,
	type AttachmentExtractJobPayload,
	type ConnectorGuideJobPayload,
	type ConnectorGuideJobResult,
	type ConnectorLessonJobPayload,
	type ConnectorLessonJobResult,
	type LessonReviewJobPayload,
	type LessonReviewJobResult,
	type SkillReviewJobPayload,
	type SkillReviewJobResult,
	type DataRetentionJobPayload,
	type DataRetentionJobResult,
	type AttachmentExtractJobResult,
	type MemoryCleanupJobPayload,
	type MemoryCleanupJobResult,
	type MemoryReviewJobPayload,
	type MemoryReviewJobResult,
	type SummaryJobPayload,
	type SummaryJobResult,
} from "@workspace/shared";
import {
	AGENT_RUN_QUEUE_NAME,
	CHAT_QUEUE_NAME,
	ROUTINE_QUEUE_NAME,
	createAgentRunQueue,
	createChatCompletionQueue,
	createRedisConnection,
	closeRunSignals,
	closeSweepSignals,
	subscribeSweepSignals,
	type SweepSignalKind,
	createRoutineQueue,
	enqueueRoutineEventDeferred,
	reconcileOnceRoutines,
	rehydrateRoutineSchedulers,
	subscribeRunSignals,
	publishRunEventsSignal,
	syncRoutineScheduler,
} from "@workspace/queue";
import {
	appendConversationMessage,
	createRoutineRun,
	findOpenRoutineRunSince,
	markRoutineRunFailed,
	prisma,
	setRunEventAppendedHook,
	cancelStaleCancelledRuns,
	listTerminalRunsWithPendingInputs,
	claimDueDeliveries,
	finishDeliveries,
	getUserEmail,
	recoverStuckDeliveries,
	settleSeenDeliveries,
	completeMissedOnceRoutine,
	failAgentRunAfterRetries,
	failStaleRunningRuns,
	findConversationsNeedingSummary,
	listOnceRoutines,
	listSchedulableRoutines,
	markRunJobEnqueued,
	recoverStaleRunningRuns,
} from "@workspace/db";
import { sendMail } from "@workspace/mail";
import { sweepDeliveryBacklog } from "./delivery/backlog.js";
import { loadWorkerConfig } from "./config.js";
import { createNotifier, createRedisCoalesce, createRedisPresence, installPushListener, logArtifactDir } from "@workspace/db";
import { createWebPushSender } from "@workspace/mail";
import { formatMissingEnv, readVapidConfig, vapidProblems } from "@workspace/shared";
import { captureError, initSentry, installRequestIdLogging, requestIdForJob, runWithRequestId, startWorkerHeartbeat } from "@workspace/observability";
import { buildRunLeaseOwner } from "./lease-owner.js";
import { warmAttachmentExtract } from "./attachments.js";
import { processChatCompletionJob } from "./processors/chat-completion.js";
import { processMemoryCleanup } from "./processors/memory-cleanup.js";
import { processMemoryReview } from "./processors/memory-review.js";
import { processLessonReview } from "./processors/lesson-review.js";
import { processSkillReview } from "./processors/skill-review.js";
import { processSummaryJob } from "./processors/summary.js";
import { processConnectorGuideJob, processConnectorLessonJob } from "./processors/connector-guide.js";
import { chainRunFollowUp, finalizeExhaustedAgentRun, processAgentRunJob } from "./processors/agent-run.js";
import { processExecuteRoutineJob } from "./processors/routine.js";
import { reportRoutineFailure, type RoutineFailureDeps } from "./processors/routine-failure.js";
import { startBotMessageSweeper } from "./bot-messages.js";
import { processDataRetention, scheduleDataRetention } from "./data-retention.js";
import { createGroupJev, createGroupRouter, startGroupSweeper } from "./bot-groups.js";
import { createAutoBriefEnsurer } from "./brief-auto.js";
import { startProactiveSweeper } from "./proactive.js";
import { briefDeliveryDeps, createBriefFlusher, createDelayedBriefFlush, flushPendingBriefs } from "./daily-brief.js";
import { startReflectionSweeper } from "./reflection.js";

// Observabilidade: Sentry só com SENTRY_DSN; logs do job ganham o request-id da API; variáveis que faltam por recurso.
initSentry("worker");
installRequestIdLogging();
for (const line of formatMissingEnv(process.env, "worker")) console.warn(line);
logArtifactDir();

const config = loadWorkerConfig();
const connection = createRedisConnection(config.redisUrl);
// Acorda os streams SSE da API quando o run ganha evento (no lugar de a API consultar o banco a cada 80ms).
setRunEventAppendedHook((runId) => void publishRunEventsSignal(runId));
// O worker não tem HTTP: publica commit/uptime no Redis para o Diagnóstico da API.
startWorkerHeartbeat(connection);

/** Roda o processador do job dentro do contexto do request-id que veio no payload. */
function traced<T, R>(fn: (job: Job<T, R>) => Promise<R>): (job: Job<T, R>) => Promise<R> {
	return (job) => runWithRequestId(requestIdForJob(job), () => fn(job));
}
const chatQueue = createChatCompletionQueue(connection);
const agentRunQueue = createAgentRunQueue(connection);
const routineQueue = createRoutineQueue(connection);
const leaseOwner = `worker-${randomUUID().slice(0, 8)}`;

// Notificações push: só com as chaves VAPID. Sem elas o worker segue normal, sem avisos no celular.
const vapid = readVapidConfig(process.env);
const notify = vapid
	? createNotifier({ sender: createWebPushSender(vapid), presence: createRedisPresence(connection), coalesce: createRedisCoalesce(connection) })
	: undefined;
if (notify) installPushListener(notify);
console.info(vapid ? "[push] worker: notificações push ligadas" : `[push] worker: notificações push DESLIGADAS (${vapidProblems(process.env).join("; ")})`);

connection.on("error", (err) => {
	console.error("Redis connection error", err);
});

type AtlasJobPayload =
	| ChatCompletionJobPayload
	| MemoryReviewJobPayload
	| MemoryCleanupJobPayload
	| SummaryJobPayload
	| AttachmentExtractJobPayload
	| ConnectorGuideJobPayload
	| ConnectorLessonJobPayload
	| LessonReviewJobPayload
	| SkillReviewJobPayload
	| DataRetentionJobPayload;
type AtlasJobResult =
	| ChatCompletionJobResult
	| MemoryReviewJobResult
	| MemoryCleanupJobResult
	| SummaryJobResult
	| AttachmentExtractJobResult
	| ConnectorGuideJobResult
	| ConnectorLessonJobResult
	| LessonReviewJobResult
	| SkillReviewJobResult
	| DataRetentionJobResult;

const chatWorker = new Worker<AtlasJobPayload, AtlasJobResult>(
	CHAT_QUEUE_NAME,
	traced(async (job) => {
		switch (job.name) {
			case ATLAS_JOB_NAMES.chatCompletion:
				return processChatCompletionJob(
					job as Job<ChatCompletionJobPayload, ChatCompletionJobResult>,
					config,
				);
			case ATLAS_JOB_NAMES.memoryReview:
				return processMemoryReview(
					job as Job<MemoryReviewJobPayload, MemoryReviewJobResult>,
					config,
				);
			case ATLAS_JOB_NAMES.memoryCleanup:
				return processMemoryCleanup(job as Job<MemoryCleanupJobPayload, MemoryCleanupJobResult>, config);
			case ATLAS_JOB_NAMES.summaryWrite:
				return processSummaryJob(
					job as Job<SummaryJobPayload, SummaryJobResult>,
					config,
				);
			case ATLAS_JOB_NAMES.connectorGuide:
				return processConnectorGuideJob(job as Job<ConnectorGuideJobPayload, ConnectorGuideJobResult>, config);
			case ATLAS_JOB_NAMES.connectorLesson:
				return processConnectorLessonJob(job as Job<ConnectorLessonJobPayload, ConnectorLessonJobResult>, config);
			case ATLAS_JOB_NAMES.lessonReview:
				return processLessonReview(job as Job<LessonReviewJobPayload, LessonReviewJobResult>, config);
			case ATLAS_JOB_NAMES.skillReview:
				return processSkillReview(job as Job<SkillReviewJobPayload, SkillReviewJobResult>, config);
			case ATLAS_JOB_NAMES.dataRetention:
				return processDataRetention();
			case ATLAS_JOB_NAMES.attachmentExtract: {
				const payload = (job as Job<AttachmentExtractJobPayload, AttachmentExtractJobResult>).data;
				return { status: await warmAttachmentExtract(payload) };
			}
			default: {
				const message = `No processor for job name: ${job.name}`;
				console.error(message);
				throw new Error(message);
			}
		}
	}),
	{ connection },
);

const AGENT_RUN_LOCK_MS = 120_000;

/** Horário em que o disparo deveria rodar (criação + atraso do job). */
function routineOccurrenceAt(job: Job): Date {
	return new Date(job.timestamp + (job.opts.delay ?? 0));
}

const routineFailureDeps: RoutineFailureDeps = {
	loadRoutine: async (routineId) => {
		const routine = await prisma.routine.findUnique({
			where: { id: routineId },
			select: { id: true, name: true, timezone: true, userId: true, botId: true },
		});
		if (!routine) return null;
		const bot = await prisma.bot.findFirst({
			where: { id: routine.botId, ownerId: routine.userId ?? undefined },
			select: { conversationId: true },
		});
		return { id: routine.id, name: routine.name, timezone: routine.timezone, userId: routine.userId, conversationId: bot?.conversationId ?? null };
	},
	markRunFailed: markRoutineRunFailed,
	findOpenRun: findOpenRoutineRunSince,
	createFailedRun: async (routineId, triggeredBy, reason) =>
		(await createRoutineRun({ routineId, triggeredBy, status: "failed", error: reason })).id,
	appendMessage: async (conversationId, text) => {
		await appendConversationMessage(conversationId, "assistant", text);
	},
	push: notify ? (userId, conversationId, text) => notify(userId, conversationId, "reminder", text) : undefined,
};

// Deploy/SIGTERM: runs ativos são contados para o shutdown esperar o passo atual e,
// se não terminar a tempo, abortar com checkpoint (ver shutdown.ts).
const activeAgentRuns = createActiveTracker();
const shutdownController = new AbortController();

async function enqueueChainedRun(nextRunId: string, options: { delayMs?: number } = {}): Promise<boolean> {
	try {
		await agentRunQueue.add(
			ATLAS_JOB_NAMES.runAgent,
			{ runId: nextRunId },
			{ jobId: `agent-run-${nextRunId}`, ...(options.delayMs && options.delayMs > 0 ? { delay: options.delayMs } : {}) },
		);
		await markRunJobEnqueued(nextRunId);
		return true;
	} catch (error) {
		console.error(`enqueue chained run failed ${nextRunId}`, error);
		return false;
	}
}

/**
 * Rede de segurança (V2): run terminado com entrada do usuário ainda pendente
 * (cancelado por reconciliador, worker morto, retries esgotados). Promove ao
 * próximo turno; idempotente, pois o consumo é atômico com a criação do run.
 */
async function promoteOrphanInputs(): Promise<void> {
	for (const run of await listTerminalRunsWithPendingInputs()) {
		if (!run.userId) continue;
		await chainRunFollowUp(run, run.userId, { enqueueNextRun: enqueueChainedRun });
	}
}

const agentWorker = new Worker<AgentRunJobPayload, AgentRunJobResult>(
	AGENT_RUN_QUEUE_NAME,
	traced(async (job) => {
		if (job.name !== ATLAS_JOB_NAMES.runAgent) {
			throw new Error(`No processor for job name: ${job.name}`);
		}
		// Lease por tentativa de execução, não por processo (W1).
		return activeAgentRuns.track(async () => {
		try {
		return await processAgentRunJob(job.data, config, buildRunLeaseOwner(leaseOwner, job), {
			notify,
			shutdownSignal: shutdownController.signal,
			subscribeRunSignals,
			extendLock: async () => {
				if (!job.token) return;
				await job.extendLock(job.token, AGENT_RUN_LOCK_MS);
			},
			enqueueMemoryReview: async (payload) => {
				await chatQueue.add(ATLAS_JOB_NAMES.memoryReview, payload, {
					jobId: `memory-review-${job.data.runId}-${Date.now()}`,
				});
			},
			enqueueLessonReview: async (payload) => {
				// Debounce por conversa: o job fica 45 s atrasado e um segundo aviso nesse intervalo é ignorado (mesmo jobId);
				// ao terminar ele some da fila (removeOnComplete) e a conversa pode agendar o próximo.
				await chatQueue.add(ATLAS_JOB_NAMES.lessonReview, payload, {
					jobId: `lesson-review-${payload.conversationId}`,
					delay: 45_000,
					attempts: 1,
					removeOnComplete: true,
					removeOnFail: true,
				});
			},
			enqueueSkillReview: async (payload) => {
				// Depois da revisão de lições (45 s): uma por run, sem debounce (o run já é o recorte).
				await chatQueue.add(ATLAS_JOB_NAMES.skillReview, payload, {
					jobId: `skill-review-${payload.runId}`,
					delay: 60_000,
					attempts: 1,
					removeOnComplete: true,
					removeOnFail: true,
				});
			},
			enqueueConnectorLesson: async (payload) => {
				await chatQueue.add(ATLAS_JOB_NAMES.connectorLesson, payload, {
					jobId: `connector-lesson-${payload.kind}-${payload.connectionId}-${job.data.runId}`,
					attempts: 1,
				});
			},
			enqueueNextRun: enqueueChainedRun,
			onRoutineMutated: async (routine) => {
				await syncRoutineScheduler(routineQueue, routine);
			},
		});
		} catch (error) {
			// Checkpoint já gravado (run "retrying", lease solto): devolve o job à fila
			// na hora, sem gastar tentativa, para o próximo worker retomar.
			if (error instanceof WorkerShuttingDownError && job.token) {
				await job.moveToDelayed(Date.now() + 1_000, job.token);
				throw new DelayedError();
			}
			throw error;
		}
		});
	}),
	{
		connection,
		concurrency: config.agentRunConcurrency,
		lockDuration: AGENT_RUN_LOCK_MS,
		stalledInterval: 30_000,
		maxStalledCount: 2,
	},
);

const routineWorker = new Worker<
	ExecuteRoutineJobPayload,
	ExecuteRoutineJobResult
>(
	ROUTINE_QUEUE_NAME,
	traced(async (job) => {
		if (job.name !== ATLAS_JOB_NAMES.executeRoutine) {
			throw new Error(`No processor for job name: ${job.name}`);
		}
		return processExecuteRoutineJob(job.data, config, agentRunQueue, {
			attemptsMade: job.attemptsMade,
			deferJob: (payload, delayMs) =>
				enqueueRoutineEventDeferred(routineQueue, payload, delayMs),
			onGaveUp: async ({ reason, routineRunId }) => {
				await reportRoutineFailure(
					{ payload: { ...job.data, routineRunId }, reason, at: routineOccurrenceAt(job), openedAfter: new Date(job.timestamp), alreadyClosedRunId: routineRunId },
					routineFailureDeps,
				);
			},
		});
	}),
	{
		connection,
		concurrency: 2,
	},
);

chatWorker.on("ready", () => {
	console.log(
		`Atlas worker listening on queue "${CHAT_QUEUE_NAME}" (Redis: ${config.redisUrl})`,
	);
});

agentWorker.on("ready", () => {
	console.log(
		`Atlas worker listening on queue "${AGENT_RUN_QUEUE_NAME}" as ${leaseOwner} (concurrency ${config.agentRunConcurrency})`,
	);
});

routineWorker.on("ready", () => {
	console.log(
		`Atlas worker listening on queue "${ROUTINE_QUEUE_NAME}" as ${leaseOwner}`,
	);
});

const onFailed = (label: string) => (job: Job | undefined, err: Error) => {
	console.error(
		`[${label}] Job failed id=${job?.id ?? "unknown"} name=${job?.name ?? "unknown"}:`,
		err.message,
	);
	captureError(err, { queue: label, job: job?.name, request_id: requestIdFromJobSafe(job) });
};

function requestIdFromJobSafe(job: Job | undefined): string | undefined {
	return job ? requestIdForJob(job) : undefined;
}

async function handleAgentRunFailure(
	job: Job<AgentRunJobPayload, AgentRunJobResult> | undefined,
	err: Error,
): Promise<void> {
	onFailed("agent")(job, err);
	if (!job || job.name !== ATLAS_JOB_NAMES.runAgent) return;

	// Permanente: finaliza já, sem esperar esgotar attempts.
	if (err instanceof UnrecoverableError) {
		try {
			const finalized = await failAgentRunAfterRetries(
				job.data.runId,
				err.message,
			);
			if (finalized) {
				console.error(`[agent] Run ${job.data.runId} falhou (permanente): ${err.message}`);
			}
		} catch (finalizeError) {
			console.error(
				`[agent] Could not finalize run ${job.data.runId} after unrecoverable:`,
				finalizeError,
			);
		}
		return;
	}

	const attempts = typeof job.opts.attempts === "number" ? job.opts.attempts : 1;
	if (job.attemptsMade < attempts) return;

	// Fecha como fim normal com falha: mensagem amigável no chat, entrega liquidada e pendentes encadeados.
	const finalized = await finalizeExhaustedAgentRun(job.data.runId, err, attempts, {
		enqueueNextRun: enqueueChainedRun,
	});
	if (finalized) {
		console.error(`[agent] Run ${job.data.runId} finalizado após esgotar retries`);
	}
}

chatWorker.on("failed", onFailed("chat"));
agentWorker.on("failed", (job, err) => {
	void handleAgentRunFailure(job, err);
});
// Falha definitiva (tentativas esgotadas): marca a execução como falha e avisa o usuário uma vez.
routineWorker.on("failed", (job, err) => {
	onFailed("routine")(job, err);
	if (!job || job.name !== ATLAS_JOB_NAMES.executeRoutine) return;
	const attempts = typeof job.opts.attempts === "number" ? job.opts.attempts : 1;
	if (job.attemptsMade < attempts && !(err instanceof UnrecoverableError)) return;
	void reportRoutineFailure(
		{ payload: job.data, reason: err.message, at: routineOccurrenceAt(job), openedAfter: new Date(job.timestamp) },
		routineFailureDeps,
	).catch((error) => console.error("[routine] aviso de falha não enviado", error));
});

// Conversa entre bots (send_to_bot): entrega, resposta e despertar do remetente.
// Aviso da API (Redis): turno de grupo ou mensagem entre bots criados fora deste processo.
const sweepSignal = (kind: SweepSignalKind) => (kick: () => void) =>
	subscribeSweepSignals((signal) => {
		if (signal === kind) kick();
	});
const botMessageSweeper = startBotMessageSweeper(
	{
		enqueueRun: enqueueChainedRun,
		envDefaultModel: config.openRouterModel,
	},
	{ triggers: [sweepSignal("bot-messages")] },
);
// Run terminou: a resposta do destino sai na hora em vez de esperar o intervalo.
agentWorker.on("completed", () => botMessageSweeper.kick());
agentWorker.on("failed", () => botMessageSweeper.kick());

// Grupos de bots: roteia a fala do usuário e dispara as respostas dos membros, uma por vez.
const groupSweeper = startGroupSweeper(
	{
		enqueueRun: enqueueChainedRun,
		envDefaultModel: config.openRouterModel,
		route: createGroupRouter(config),
		jev: createGroupJev(config),
	},
	{ triggers: [sweepSignal("groups")] },
);
agentWorker.on("completed", () => groupSweeper.kick());
agentWorker.on("failed", () => groupSweeper.kick());

// Brief "Seu dia" pendente entra no chat assim que a conversa fica livre (uma consulta indexada por briefStatus).
const flushBriefs = createBriefFlusher(() => flushPendingBriefs(briefDeliveryDeps(notify)));

// A rotina criada aqui nasce fora de um run: sem este hook o cron só seria agendado no próximo boot.
const ensureAutoBriefs = createAutoBriefEnsurer({ onCreated: (routine) => syncRoutineScheduler(routineQueue, routine) });

// Modo proativo: lembretes vencidos e reflexão diária (o banco guarda tudo; reinício retoma os pendentes).
const proactiveSweeper = startProactiveSweeper(
	{
		enqueueRun: enqueueChainedRun,
		envDefaultModel: config.openRouterModel,
	},
	// Cada ciclo (fim de run e a cada 60 s) também libera briefs pendentes e dispara a garantia do "Seu dia" ligado
	// por padrão. Esta não é aguardada: roda em segundo plano (orçamento e cursor próprios, nunca lança) para não
	// atrasar o sweep do modo proativo.
	async () => {
		await flushBriefs();
		void ensureAutoBriefs();
	},
);
agentWorker.on("completed", () => proactiveSweeper.kick());
// Run que falhou só libera o brief; o modo proativo (follow-ups, reflexão) não roda por falha, como antes.
agentWorker.on("failed", () => void flushBriefs());
// A conversa só fica livre ~5 s depois do fim de um run (margem de calma): uma varredura agendada para logo
// depois evita que o brief espere o ciclo de 60 s. Juntam-se numa só; o timer não segura o processo.
const flushBriefsAfterCalm = createDelayedBriefFlush(flushBriefs);
agentWorker.on("completed", flushBriefsAfterCalm);
agentWorker.on("failed", flushBriefsAfterCalm);

// Reflexão diária do orquestrador (horário escolhido pelo usuário) e "Refletir agora".
const reflectionSweeper = startReflectionSweeper({ enqueueRun: enqueueChainedRun, config, notify });

async function recoverExpiredLeases(): Promise<void> {
	const recovered = await recoverStaleRunningRuns();
	for (const runId of recovered) {
		const jobId = `agent-run-${runId}`;
		try {
			const existing = await agentRunQueue.getJob(jobId).catch(() => null);
			if (existing) {
				const state = await existing
					.getState()
					.catch((): string | null => null);
				if (state === "completed" || state === "failed" || state === null) {
					await existing.remove().catch(() => undefined);
				} else {
					await markRunJobEnqueued(runId);
					continue;
				}
			}
			await agentRunQueue.add(
				ATLAS_JOB_NAMES.runAgent,
				{ runId },
				{ jobId },
			);
			await markRunJobEnqueued(runId);
		} catch (error) {
			console.error(`[agent] re-enqueue recovered run failed ${runId}`, error);
		}
	}
	if (recovered.length > 0) {
		console.warn(`[agent] recovered stale running runs: ${recovered.length}`);
	}
}

async function reconcileStaleRuns(): Promise<void> {
	try {
		await recoverExpiredLeases();
		// Cancel órfão (worker morreu antes de observar): graça curta, o lease
		// saudável renova a cada 10s então 30s só pega órfão de verdade.
		const [failed, cancelled] = await Promise.all([
			failStaleRunningRuns(),
			cancelStaleCancelledRuns(30_000),
		]);
		if (failed.length > 0 || cancelled.length > 0) {
			console.warn(
				`[agent] reconciled stale runs: failed=${failed.length} cancelled=${cancelled.length}`,
			);
		}
	} catch (error) {
		console.error("[agent] stale run reconciliation failed", error);
	}
}

// Única dona da reconciliação de runs presos (a API não repete): a cada 15 s, a cadência que a API usava.
const STALE_RUN_RECONCILE_MS = 15_000;
void reconcileStaleRuns();
const staleRunReconciler = setInterval(() => {
	void reconcileStaleRuns();
}, STALE_RUN_RECONCILE_MS);

// Entradas órfãs (steer de run que acabou): a cada minuto, como antes.
async function promoteOrphanInputsSafely(): Promise<void> {
	try {
		await promoteOrphanInputs();
	} catch (error) {
		console.error("[agent] orphan input promotion failed", error);
	}
}
void promoteOrphanInputsSafely();
const orphanInputPromoter = setInterval(() => {
	void promoteOrphanInputsSafely();
}, 60_000);

// Fase 1: resumo por inatividade (30 min sem msg, sem run ativo, com
// conteúdo novo). jobId determinístico por estado; duplicata viva pula.
// Falha recente entra em cooldown (não re-enfileira a cada varredura em loop).
// A cada 5 min: com 30 min de ociosidade, alguns minutos a mais não mudam nada para o usuário.
const SUMMARY_IDLE_MS = 30 * 60 * 1000;
const SUMMARY_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const SUMMARY_FAIL_COOLDOWN_MS = 30 * 60 * 1000;

async function sweepIdleConversations(): Promise<void> {
	try {
		const candidates = await findConversationsNeedingSummary(
			SUMMARY_IDLE_MS,
			20,
			20,
		);
		let enqueued = 0;
		for (const candidate of candidates) {
			const jobId = `summary-${candidate.conversationId}-${candidate.lastMessageId}`;
			try {
				const existing = await chatQueue.getJob(jobId).catch(() => null);
				if (existing) {
					const state = await existing.getState().catch(() => null);
					if (
						state === "waiting" ||
						state === "delayed" ||
						state === "active"
					) {
						continue;
					}
					if (state === "failed") {
						const failedAt =
							typeof existing.finishedOn === "number"
								? existing.finishedOn
								: 0;
						if (Date.now() - failedAt < SUMMARY_FAIL_COOLDOWN_MS) {
							continue;
						}
					}
					await existing.remove().catch(() => undefined);
				}
				await chatQueue.add(
					ATLAS_JOB_NAMES.summaryWrite,
					{
						conversationId: candidate.conversationId,
						botId: candidate.botId ?? undefined,
						trigger: "idle",
					},
					{ jobId },
				);
				enqueued += 1;
			} catch (error) {
				console.error(
					`[summary] enqueue failed conversation=${candidate.conversationId}`,
					error,
				);
			}
		}
		if (enqueued > 0) {
			console.log(`[summary] enfileirados: ${enqueued}`);
		}
	} catch (error) {
		console.error("[summary] idle sweep failed", error);
	}
}

// Retenção diária (run_events de runs encerrados há 30+ dias, execuções de rotina além das 50 últimas).
void scheduleDataRetention(chatQueue).catch((error) => console.error("[retention] agendamento falhou", error));

void sweepIdleConversations();
const summarySweeper = setInterval(() => {
	void sweepIdleConversations();
}, SUMMARY_SWEEP_INTERVAL_MS);

// Entrega offline (F5): a cada minuto, resultados de runs em que o usuário avisou que ia
// sair e já passou a janela/horário combinado saem num e-mail só por usuário.
async function sweepDeliveries(): Promise<void> {
	try {
		const { sent, failed } = await sweepDeliveryBacklog({
			settleSeen: settleSeenDeliveries,
			recoverStuck: recoverStuckDeliveries,
			claimDue: (now) => claimDueDeliveries(now),
			emailOf: getUserEmail,
			send: sendMail,
			finish: (ids, ok) => finishDeliveries(ids, ok),
		});
		if (sent || failed) console.log(`[delivery] enviados=${sent} falhas=${failed}`);
	} catch (error) {
		console.error("[delivery] sweep failed", error);
	}
}

void sweepDeliveries();
const deliverySweeper = setInterval(() => {
	void sweepDeliveries();
}, 60_000);

void listSchedulableRoutines()
	.then((routines) => rehydrateRoutineSchedulers(routineQueue, routines))
	.then(() => {
		console.log("Routine schedulers rehydrated from Postgres");
	})
	.catch((error) => {
		console.error("routine scheduler rehydrate failed", error);
	});

/**
 * Reconcile de boot pras rotinas `once` (lembrete de uma vez só): garante
 * job atrasado pra quem ainda está no futuro/levemente atrasado (cobre um
 * Redis limpo entre a criação e agora); quem passou de 1h de atraso é
 * "perdida" — apaga a rotina e avisa na conversa (mesmo canal dos avisos de
 * execução normal, via `appendConversationMessage`).
 */
async function reconcileOnceRoutinesOnBoot(): Promise<void> {
	try {
		const routines = await listOnceRoutines();
		const { missed } = await reconcileOnceRoutines(routineQueue, routines);
		for (const { id } of missed) {
			const info = await completeMissedOnceRoutine(id);
			if (info?.conversationId) {
				await appendConversationMessage(
					info.conversationId,
					"assistant",
					`Perdi o horário do lembrete "${info.name}" (passou de 1h de atraso) — removi a rotina.`,
				).catch((error) => {
					console.error(`notify missed once routine failed routine=${id}`, error);
				});
			}
		}
		if (missed.length > 0) {
			console.warn(`[routine] rotinas 'once' perdidas no reconcile de boot: ${missed.length}`);
		}
	} catch (error) {
		console.error("once routine reconcile failed", error);
	}
}

void reconcileOnceRoutinesOnBoot();

function positiveMs(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

let shuttingDown = false;
async function shutdown() {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log("Shutting down worker...");
	// Rede de segurança: o compose dá 130s (stop_grace_period); sair antes do SIGKILL.
	setTimeout(() => {
		console.error("[shutdown] tempo esgotado; saindo à força");
		process.exit(1);
	}, 125_000).unref();
	clearInterval(staleRunReconciler);
	clearInterval(orphanInputPromoter);
	botMessageSweeper.stop();
	groupSweeper.stop();
	proactiveSweeper.stop();
	reflectionSweeper.stop();
	clearInterval(summarySweeper);
	clearInterval(deliverySweeper);
	// Para de pegar jobs novos e dá ao run ativo um tempo limitado; passando disso, checkpoint + lease liberado.
	const outcome = await drainAgentWork({
		pause: async () => {
			await Promise.all([
				chatWorker.pause(true),
				agentWorker.pause(true),
				routineWorker.pause(true),
			]);
		},
		activeCount: activeAgentRuns.count,
		whenIdle: activeAgentRuns.whenIdle,
		requestCheckpoint: () => shutdownController.abort(),
		softGraceMs: positiveMs(process.env.WORKER_SHUTDOWN_GRACE_MS, 90_000),
	});
	console.log(`[shutdown] runs: ${outcome}`);
	await Promise.all([
		chatWorker.close(),
		agentWorker.close(outcome === "timed-out"),
		routineWorker.close(),
	]);
	await Promise.all([
		chatQueue.close(),
		agentRunQueue.close(),
		routineQueue.close(),
	]);
	await closeSharedMcpPool().catch(() => undefined);
	await shutdownSharedExtractor().catch(() => undefined);
	await closeRunSignals().catch(() => undefined);
	await closeSweepSignals().catch(() => undefined);
	await connection.quit();
	process.exit(0);
}

process.on("SIGINT", () => {
	void shutdown();
});
process.on("SIGTERM", () => {
	void shutdown();
});
