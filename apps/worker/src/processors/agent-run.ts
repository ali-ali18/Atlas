import { createRunProviderServices } from "../provider-services.js";
import { createAssistantSegmentRecorder } from "../assistant-segments.js";
import { recordObserveChecks } from "../observe-checks.js";
import { isNoUpdateReply, shouldReviewForSkill, type AlertVerdict, type ConnectorLessonJobPayload, type InspectContextPayload, type InspectHooksPayload, type InspectLessonsPayload, type LessonFeedbackEntry, type LessonReviewJobPayload, type RoutineNotifyMode, type SkillReviewJobPayload } from "@workspace/shared";
import { REVISED_DRAFT_MAX_CHARS, parseQuestionnaireAnsweredContent, isRecheckObjective, isRecheckToolAllowed, parseModelRef, readPlanMode } from "@workspace/shared";
import {
	ATLAS_JOB_NAMES,
	COMPACT_TAIL_KEEP,
	buildConversationTaskNote,
	type AgentRun,
	type AgentRunCheckpoint,
	type AgentRunJobPayload,
	type AgentRunJobResult,
	type ChatMessage,
	type ComputerUseEvent,
	type MemoryReviewJobPayload,
	buildToolResultNotes,
	type RoutineRecord,
	type SessionMessage,
	type UserSettings,
	formatCostLabel,
	isLlmChatRole,
	readDecideForOtherBots,
	readSubagentModel,
	TRANSCRIPT_SLOT,
	type TranscriptWatermark,
	type CarriedNote,
} from "@workspace/shared";
import {
	type Notify,
	prisma,
	appendAgentStep,
	appendConversationCard,
	listOpenBotRequests,
	appendRunAssistantSegment,
	appendRunEvent,
	countCompletedToolResults,
	countFailedToolResults,
	getLatestLessonReviewEvent,
	getSkillPendingIntent,
	upsertTaskListCard,
	listBotLessons,
	recordLessonFeedback,
	createPublishThrottle,
	publishUserEvent,
	buildMemoryAugmentedMessages,
	type MemoryContextOptions,
	completeAgentRunAtomically,
	createFollowUpRun,
	createRunInput,
	findCompletedToolStep,
	findStartedToolStep,
	cancelRunDelivery,
	markDeliveryReady,
	recordAwayNote,
	finishAgentRun,
	getAgentRun,
	failAgentRunAfterRetries,
	getAgentRunCheckpoint,
	getBotProfile,
	getBotName,
	getBotPolicy,
	getFreshSummary,
	getRunLeaseState,
	getUserSettings,
	hasPendingQuestionnaireCard,
	getRunControlState,
	isRunCancelRequested,
	requestCancelAgentRun,
	requestPauseAgentRun,
	applyReconciledStepCost,
	addLateRunUsage,
	listConversationArtifacts,
	listConversationResearchNotes,
	getConversationTaskContext,
	getConversationTaskLedger,
	getConversationTaskList,
	listPendingQueueInputs,
	listStepsMissingCost,
	listPendingSteerInputs,
	listPendingInterruptInputIds,
	getGroupRunContext,
	listUserBotRoster,
	loadRecentConversationMessages,
	getConversationTranscript,
	getConversationWatermark,
	getRunTranscript,
	loadMessagesAfterWatermark,
	withMessageRunId,
	loadScreenshotArtifact,
	loadUserImageHistory,
	markAgentRunRetrying,
	persistRunProgress,
	persistScreenshotArtifact,
	readRunContextLength,
	readRunModelAuto,
	releaseRunLease,
	releasePausedRunLease,
	renewRunLease,
	setRunSandboxSession,
	touchBotProfileCard,
	touchQuestionnaireCard,
	tryAcquireRunLease,
	type RunLease,
	getAccountConfig,
	getRoutine,
	getRoutineAlertForAgentRun,
	getRoutineContextForAgentRun,
	getRoutineNotifyModeForAgentRun,
	getRoutinePageIdForAgentRun,
	persistConversationCardFromEvent,
	recordRoutineAlertState,
} from "@workspace/db";
import {
	AgentRunCancelledError,
	AgentRunLoopDetectedError,
	AgentRunPausedError,
	BudgetExhaustedError,
	LeaseLostError,
	buildConversationArtifactsNote,
	classifyRunError,
	contextTranscriptEnabled,
	mergeCarriedNotes,
	describeRunError,
	appendTurnNote,
	createJevTelemetryCollector,
	errorFromAbortSignal,
	loadApiConnectorRuntime,
	loadEmailRunContext,
	loadMcpRuntime,
	parseBudgetPolicy,
	resolveBudget,
	runComputerUse,
	wallClockAnchors,
} from "@workspace/agent-runtime";
import { budgetStopFallbackText, createReviewerClient, resolveMaintenanceCandidates } from "@workspace/agent-runtime";
import { appendConversationMessage } from "@workspace/db";
import {
	AUTO_CONTINUE_MAX,
	AUTO_CONTINUE_STATUS_TEXT,
	autoContinueCauseOfBudgetStop,
	autoContinueScheduled,
	autoContinueCauseOfFailure,
	planAutoContinue,
	readAutoContinueAttempt,
	scheduleAutoContinue,
	type AutoContinueDecision,
	type AutoContinueIo,
} from "../auto-continue.js";
import { createAutoContinueIo } from "../auto-continue-io.js";
import { resolveTranscriptHistory, type TranscriptHistory } from "./transcript-history.js";
import {
	createRunTelemetryTracker,
	stepTelemetryFields,
	withRunTelemetry,
} from "../run-telemetry.js";
import {
	createSandboxManager,
	loadSandboxConfig,
	type SandboxManager,
} from "@workspace/sandbox";
import { UnrecoverableError } from "bullmq";
import type { WorkerConfig } from "../config.js";
import {
	HISTORY_LIMIT_ECONOMY,
	accountBudgetPolicy,
	appendObjective,
	effectiveCostCapUsd,
	historyWindowFor,
	resolveRunConfigSnapshot,
	runtimeBudgetParams,
	runtimeParamsFromSnapshot,

	resolveRunCodingModel,
	resolveRunModelTiers,
	visionFallbackFromSnapshot,
	withConfigSnapshot,
} from "../run-config.js";
import { createRunEventCoalescer } from "../coalesce-run-events.js";
import { createRunControlReader } from "../run-control.js";
import { loadRunBase } from "../run-setup.js";
import { resolveRunAutonomy } from "../run-autonomy.js";
import { actionsJevMode, actionsJudgeModel, pendingJevMode, proactiveFailureDisplay, proactiveJevMode, resolveProactiveForRun, resolveUserPushForRun } from "../proactive-run.js";
import { loadRunSkillIndex } from "../run-skills.js";
import { planAlertRun, settleAlertRun } from "../routine-alert.js";
import { notifyRoutineRunFailure, type RoutineRunFailureDeps } from "../routine-run-failure.js";
import { buildMentionNotes } from "../run-mentions.js";
import { getOpenRouterContextLength, isKnownOpenRouterModel } from "../openrouter-models.js";
import { imageVisionForRun } from "../image-vision.js";
import { attachmentRuntimeForRun } from "../attachments.js";
import { chainFollowUp, followUpRequest, laterFollowUpInput } from "../follow-up.js";
import { runPostCompletionSteps } from "../post-completion.js";
import { shouldReviewLessons } from "../lesson-trigger.js";
import { reconcileRunCosts } from "../cost-reconcile.js";
import { createAwayNoteHandler, settleRunDelivery, type RunEnd } from "../delivery/run-hooks.js";
import { acquireRunLeaseOrYield } from "../lease-owner.js";
import { startLeaseGuards, tickLeaseHeartbeat, type LeaseGuards } from "../lease-guards.js";

export { tickLeaseHeartbeat };

/** Atividade do run no hub: um aviso por run a cada 3 s (o texto vai pelo stream do run). */
const runActivityThrottle = createPublishThrottle(3_000);

/** Vale avisar o usuário do fim deste run? Sem conversa, sem texto ou de subagente, não. */
export function shouldPushRunEnd(run: { conversationId?: string | null; origin?: string | null }, text: string, hasNotify = true, routineNotify: RoutineNotifyMode = "always", alertRun = false): boolean {
	// Rotina de alerta (quem avisa é o veredito, só na virada) ou verificação sem novidade: nunca avisa no fim.
	if (alertRun) return false;
	// Rotina "só importante": o resultado fica no chat sem push; quem avisa é o `notify_user` do próprio run.
	if (run.origin === "routine" && routineNotify === "important") return false;
	return hasNotify && Boolean(run.conversationId) && text.trim().length > 0 && run.origin !== "subagent";
}

/** Origem automatizada (lembrete proativo, rotina, webhook) é "lembrete"; conversa normal é "terminou". */
export function pushKindForOrigin(origin: string | null | undefined): "reminder" | "run-finished" {
	return origin === "proactive" || origin === "routine" || origin === "webhook" ? "reminder" : "run-finished";
}

/** Aviso de rotina que falhou: contexto escopado pelo dono + push `routine-failed` (ausente = sem VAPID). */
export function routineRunFailureDeps(deps: Pick<AgentRunProcessorDeps, "notify">): RoutineRunFailureDeps {
	return {
		loadContext: (agentRunId, userId) => getRoutineContextForAgentRun(agentRunId, userId),
		push: deps.notify ? (userId, conversationId, text) => deps.notify!(userId, conversationId, "routine-failed", text) : undefined,
	};
}

export type AgentRunProcessorDeps = {
	/** Notificação push (ausente = sem chaves VAPID). Ver `createNotifier` em @workspace/db. */
	notify?: Notify;
	enqueueMemoryReview?: (payload: MemoryReviewJobPayload) => Promise<void>;
	/** Lição de conector (falha → sucesso no run): vira job que guarda uma sugestão pendente. */
	enqueueConnectorLesson?: (payload: ConnectorLessonJobPayload) => Promise<void>;
	/** Revisão de lições em segundo plano (debounce por conversa feito por quem enfileira). */
	enqueueLessonReview?: (payload: LessonReviewJobPayload) => Promise<void>;
	/** Revisão de skill após tarefa complexa e bem-sucedida (um job por run). */
	enqueueSkillReview?: (payload: SkillReviewJobPayload) => Promise<void>;
	enqueueNextRun?: (runId: string, options?: { delayMs?: number }) => Promise<boolean>;
	/** Teste: troca a ligação da retomada automática com banco e fila. */
	autoContinueIo?: AutoContinueIo;
	extendLock?: () => Promise<void>;
	/** Shutdown do worker: aborta o run em andamento com checkpoint (ver `WorkerShuttingDownError`). */
	shutdownSignal?: AbortSignal;
	/** Sinais do run (Redis pub/sub): acorda cancel/entradas sem consultar o db a cada ciclo. Ausente = polling. */
	subscribeRunSignals?: (runId: string, onSignal: (kind: string) => void) => () => void;
	onRoutineMutated?: (
		routine: Pick<
			RoutineRecord,
			"id" | "enabled" | "schedule" | "timezone" | "triggerType"
		>,
	) => Promise<void>;
};

/** Contagens da revisão de lições que o inspetor mostra (só números e flags). */
function pickReviewCounts(payload: Record<string, unknown>): Partial<NonNullable<InspectLessonsPayload["review"]>> {
	const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
	const out: Partial<NonNullable<InspectLessonsPayload["review"]>> = {};
	for (const key of ["added", "updated", "retired", "counters", "rejected"] as const) {
		const value = num(payload[key]);
		if (value !== undefined) out[key] = value;
	}
	if (payload.skillProposal === true) out.skillProposal = true;
	if (Array.isArray(payload.signals)) out.signals = payload.signals.filter((item): item is string => typeof item === "string").slice(0, 6);
	return out;
}

async function prepareMessages(
	messages: ChatMessage[],
	botId?: string | null,
	conversationId?: string | null,
	userId?: string,
	compact?: boolean,
	group?: MemoryContextOptions["group"],
	historySlot?: string,
	volatileAfterTurn?: boolean,
	onLessons?: (ids: string[]) => void,
): Promise<ChatMessage[]> {
	// Fase 4: userId é obrigatório (vem da linha do run). Sem ele, falha
	// explícita em vez de seguir como "default".
	const effectiveUserId = userId?.trim();
	if (!effectiveUserId) {
		throw new Error(
			"prepareMessages sem userId: linha do run sem dono; falhando em vez de seguir como \"default\"",
		);
	}
	try {
		const base = await buildMemoryAugmentedMessages(messages, {
			userId: effectiveUserId,
			botId: botId ?? undefined,
			conversationId: conversationId ?? undefined,
			compact,
			...(group ? { group } : {}),
			...(historySlot ? { historySlot } : {}),
			...(volatileAfterTurn ? { volatileAfterTurn: true } : {}),
			...(onLessons ? { onLessons } : {}),
			// O runtime põe a persona do bot (identidade, estilo e idioma) no topo do prompt: aqui só o roster/grupo.
			personaInSystemPrompt: true,
		});
		return base;
	} catch (error) {
		console.error("memory context load failed; using raw messages", error);
		return messages;
	}
}

async function getRunningSession(
	manager: SandboxManager,
	sessionId: string,
): Promise<{ sessionId: string; viewerUrl: string } | null> {
	try {
		const session = await manager.getSession(sessionId);
		return session && session.status === "running" ? { sessionId: session.sessionId, viewerUrl: session.viewerUrl } : null;
	} catch {
		return null;
	}
}

async function getRunningSessionId(
	manager: SandboxManager,
	sessionId: string,
): Promise<string | null> {
	return (await getRunningSession(manager, sessionId))?.sessionId ?? null;
}

function asLeaseError(error: unknown): never {
	const message = error instanceof Error ? error.message : String(error);
	if (message === "lease_lost") {
		throw new LeaseLostError();
	}
	if (message === "cancelled") {
		throw new AgentRunCancelledError();
	}
	throw error instanceof Error ? error : new Error(message);
}

function usageText(usage: {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	costUsd?: number;
	costUnknownCalls?: number;
}): string {
	if (usage.totalTokens <= 0) return "uso de tokens não medido";
	const short = (n: number) =>
		n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
	const tokens = `${short(usage.totalTokens)} tokens`;
	// Custo conhecido só em parte nunca aparece como total.
	return usage.costUnknownCalls
		? `${tokens}, ${formatCostLabel(usage.costUsd, usage.costUnknownCalls)}`
		: tokens;
}

/**
 * queue + steer restante: nada pode ficar pending num run terminado (concluído,
 * cancelado ou falho), senão a mensagem do usuário morre no vazio e ela precisa
 * ser reenviada (V2). O `cancel` nunca é promovido: a parada não vira turno. Os inputs viram um follow-up criado e
 * consumido numa transação só (ver follow-up.ts). Nunca lança.
 */
export async function chainRunFollowUp(
	run: AgentRun,
	runUserId: string,
	deps: AgentRunProcessorDeps,
): Promise<void> {
	if (!deps.enqueueNextRun) return;
	await chainFollowUp({
		listQueued: () => listPendingQueueInputs(run.id),
		listSteers: () => listPendingSteerInputs(run.id),
		createFollowUp: (plan) =>
			createFollowUpRun({
				parentRunId: run.id,
				userId: runUserId,
				model: run.model,
				contextLength: readRunContextLength(run),
				request: followUpRequest(
					{
						model: run.model,
						conversationId: run.conversationId ?? undefined,
						botId: run.botId ?? undefined,
						origin: run.origin as "chat" | "routine" | "webhook" | "bot" | "proactive",
					},
					plan,
				),
				consume: plan.consume,
				defer: plan.defer,
			}),
		enqueueNextRun: deps.enqueueNextRun,
		announce: async (nextRunId, plan) => {
			await appendRunEvent(nextRunId, "input_received", {
				type: "input_received",
				inputId: plan.consume[0]?.id ?? nextRunId,
				mode: plan.consume[0]?.mode === "queue" ? "queue" : "join",
				content: plan.objective,
			});
		},
	});
}

export async function processAgentRunJob(
	payload: AgentRunJobPayload,
	config: WorkerConfig,
	leaseOwner: string,
	deps: AgentRunProcessorDeps = {},
): Promise<AgentRunJobResult> {
	const { runId } = payload;


	const run = await getAgentRun(runId);
	if (!run) {
		throw new Error(`AgentRun not found: ${runId}`);
	}

	if (!config.openRouterApiKey && parseModelRef(run.model).provider === "openrouter") {
		await finishAgentRun(runId, {
			status: "failed",
			error: "OPENROUTER_API_KEY is not configured on the worker",
		});
		await appendRunEvent(runId, "error", {
			type: "error",
			error: "OPENROUTER_API_KEY is not configured on the worker",
		});
		throw new UnrecoverableError(
			"OPENROUTER_API_KEY is not configured on the worker",
		);
	}

	// Fase 4: userId obrigatório da linha do run. Sem dono, falha explícita
	// (sem fallback "default" para não vazar dados entre usuários).
	const runUserId = run.userId?.trim();
	if (!runUserId) {
		const message = `AgentRun sem userId (run=${runId}): linha do run sem dono; falhando em vez de seguir como "default"`;
		console.error(message);
		await finishAgentRun(runId, {
			status: "failed",
			error: message,
		});
		await appendRunEvent(runId, "error", {
			type: "error",
			error: message,
		});
		throw new UnrecoverableError(message);
	}

	if (run.status === "cancelled" || run.cancelRequested) {
		// Parado antes de começar: o que o usuário mandou nesse meio tempo vira o próximo turno.
		if (run.status === "cancelled") await chainRunFollowUp(run, runUserId, deps);
		return { runId, status: "cancelled" };
	}

	// Reentrega depois da conclusão (crash entre concluir e criar/enfileirar o
	// follow-up): o run não executa de novo, mas retoma só o follow-up, que é
	// idempotente (inputs consumidos na mesma transação que cria o run).
	if (run.status === "completed" || run.status === "budget_exhausted") {
		await chainRunFollowUp(run, runUserId, deps);
		return { runId, status: run.status, resultText: run.resultText ?? undefined };
	}

	// `leaseOwner` identifica ESTA tentativa de execução (ver lease-owner.ts):
	// reentrega duplicada com lease vigente devolve o status sem rodar o run.
	const acquired = await acquireRunLeaseOrYield(runId, leaseOwner, {
		tryAcquire: tryAcquireRunLease,
		getState: getRunLeaseState,
	});
	if (acquired.kind === "yield") return acquired.result;
	if (acquired.kind === "unavailable") {
		throw new LeaseLostError(`Could not acquire lease for run ${runId}`);
	}
	const { lease } = acquired;

	// W3: nada entre adquirir o lease e abrir o try/finally que possa vazar timers.
	// O finally para heartbeat/cancel e solta o lease (no-op se o run já terminou).
	// O runtime MCP não tem handle por run: usa o pool compartilhado, fechado no shutdown.
	let guards: LeaseGuards | undefined;
	try {
		guards = startLeaseGuards({
			runId,
			renew: () => renewRunLease(runId, lease.owner, lease.token),
			isCancelRequested: () => isRunCancelRequested(runId),
			extendLock: deps.extendLock,
			shutdownSignal: deps.shutdownSignal,
			subscribeSignals: deps.subscribeRunSignals
				? (onSignal) => deps.subscribeRunSignals!(runId, onSignal)
				: undefined,
		});
		// As falas e cartões que o run grava na conversa ganham o id dele (ver message-run-context).
		return await withMessageRunId(runId, () => executeLeasedRun({ run, runUserId, config, deps, lease, guards: guards!, apiKey: config.openRouterApiKey ?? "" }));
	} finally {
		guards?.stop();
		await releaseRunLease(runId, lease.owner, lease.token).catch(() => undefined);
	}
}

async function executeLeasedRun(ctx: {
	run: AgentRun;
	runUserId: string;
	config: WorkerConfig;
	deps: AgentRunProcessorDeps;
	lease: RunLease;
	guards: LeaseGuards;
	apiKey: string;
}): Promise<AgentRunJobResult> {
	const { run, runUserId, config, deps, lease, guards, apiKey } = ctx;
	const runId = run.id;
	const { aborter } = guards;

	// F0: telemetria do run (setup, pós-conclusão) e do Jev, só metadados.
	const runTelemetry = createRunTelemetryTracker();
	const jevTelemetry = createJevTelemetryCollector();

	const manager = createSandboxManager(loadSandboxConfig(), runUserId);
	const unattended = run.origin === "routine" || run.origin === "webhook" || run.origin === "proactive";
	// Grupo de bots: o run é de um membro na conversa do grupo (histórico com autores, VM e memória do membro).
	// Sai junto das leituras de base abaixo (nenhuma delas depende do grupo).
	const groupRunPromise = run.origin === "chat"
		? getGroupRunContext({ userId: runUserId, botId: run.botId, conversationId: run.conversationId }).catch(() => null)
		: Promise.resolve(null);
	// Configuração da conta: uma leitura por run (snapshot, memória da conversa, fuso do aviso, modelo
	// padrão). Antes eram até quatro leituras iguais, uma depois da outra.
	const accountConfigRead = getAccountConfig(runUserId);
	accountConfigRead.catch(() => undefined);
	const loadAccountConfig = () => accountConfigRead.catch(() => null);
	// L10: leituras independentes saem juntas (settings, checkpoint, política e
	// idioma do bot, autonomia e, depois dela, conectores MCP).
	const base = await loadRunBase({
		// Fase 4: settings por usuário (getUserSettings faz fallback para o
		// legado quando o usuário ainda não tem linha própria).
		getSettings: () => getUserSettings(runUserId),
		defaultSettings: { sandboxAutoStart: true } as UserSettings,
		onSettingsError: (error) => console.error("load user settings failed; assuming sandboxAutoStart=true", error),
		getCheckpoint: () => getAgentRunCheckpoint(runId),
		getBotPolicy: async () => run.botId ? (await prisma.bot.findFirst({ where: { id: run.botId, ownerId: runUserId }, select: { policyJson: true } }))?.policyJson ?? null : null,
		getLanguage: async () => run.botId ? (await getBotProfile(run.botId, runUserId))?.language ?? "pt-BR" : "pt-BR",
		// Autonomia (F10): bot > conta > Equilibrado; vencida grava o fallback e avisa no chat.
		resolveAutonomy: () => resolveRunAutonomy({
			userId: runUserId,
			botId: run.botId,
			conversationId: run.conversationId,
			origin: run.origin,
			now: new Date(),
		}),
		// Conectores MCP da conta (marketplace). Falha ao carregar nunca derruba o
		// run: segue sem conectores. Rotina/webhook recebem só as tools que a
		// autonomia libera sem perguntar (`allow`); `block` some em qualquer run.
		loadMcp: (autonomy) => loadMcpRuntime({ userId: runUserId, autonomy, unattended, botId: run.botId ?? undefined, conversationId: run.conversationId ?? undefined }),
		onMcpError: (error) => console.error(`load mcp connectors failed run=${runId}`, error),
	});
	const { settings, checkpoint, rawBotPolicy, language, autonomy, mcp } = base;
	const groupRun = await groupRunPromise;
	const groupPrompt = groupRun && run.botId ? { name: groupRun.groupName, selfId: run.botId, members: groupRun.members } : undefined;
	// E-mail próprio do bot (tools adiadas). No run de e-mail o envio segue a política real do dono, o resto é limitado.
	// Corre junto das etapas abaixo; falha ao resolver a política do e-mail ainda derruba o run (no `await`).
	const emailContextPromise = (run.origin === "email"
		? resolveRunAutonomy({ userId: runUserId, botId: run.botId, conversationId: run.conversationId, origin: run.origin, now: new Date(), uncapped: true })
		: Promise.resolve(autonomy)
	).then((sendPolicy) =>
		loadEmailRunContext({ userId: runUserId, botId: run.botId, sendPolicy }).catch((error) => {
			console.error(`load email context failed run=${runId}`, error);
			return null;
		}),
	);
	emailContextPromise.catch(() => undefined);
	// L10: leituras que não dependem do histórico nem da configuração saem já, junto das etapas abaixo;
	// cada uma é aguardada onde é usada. Todas têm o próprio `.catch` (falha = valor padrão, como antes).
	const runLessonsPromise = run.botId && !groupRun ? listBotLessons(runUserId, run.botId).catch(() => []) : Promise.resolve([]);
	// Inspetor: resultado da última revisão de lições (ação "no run seguinte"); só run novo.
	const latestLessonReviewPromise = !checkpoint?.llmMessages?.length && run.conversationId && run.botId
		? getLatestLessonReviewEvent(runUserId, run.conversationId, runId).catch(() => null)
		: Promise.resolve(null);
	// Modo proativo: só o bot principal com o modo ligado (nunca em grupo).
	const proactiveBotPromise = run.botId && (run.origin === "chat" || run.origin === "proactive") && !groupRun
		? prisma.bot.findFirst({ where: { id: run.botId, ownerId: runUserId }, select: { isPrimary: true } }).catch(() => null)
		: Promise.resolve(null);
	// Aviso da rotina ("always" = push ao fim, como sempre) e push avulso do bot (rotina "só importante" / chat).
	const routineNotifyPromise: Promise<RoutineNotifyMode> = run.origin === "routine" ? getRoutineNotifyModeForAgentRun(runId).catch(() => "always" as const) : Promise.resolve("always");
	// Rotina ligada a uma página: o run só pode atualizar essa página (o runtime trava as outras).
	const routinePageIdPromise = run.origin === "routine" ? getRoutinePageIdForAgentRun(runId, runUserId).catch(() => null) : Promise.resolve(null);
	// Rotina de alerta: o run só verifica a condição; o aviso (com debounce) é decidido depois do veredito.
	const alertCtxPromise = run.origin === "routine" ? getRoutineAlertForAgentRun(runId, runUserId).catch(() => null) : Promise.resolve(null);
	// Triagem de mensagens do usuário durante o run: modelo barato de manutenção; falha = modelo do run.
	// Primeiro modelo da cadeia da manutenção (chave própria ou OpenRouter); sem chave ou falha = modelo do run.
	const messageTriageModelPromise = resolveMaintenanceCandidates({ kind: "summary", config, userId: runUserId })
		.then((resolved) => resolved.candidates[0]?.model)
		.catch(() => undefined);
	// Revisor (Jev): modelo escolhido > Jev fixo no OpenRouter > cadeia da manutenção. Sem caminho nenhum = Jev desligado.
	const reviewerPromise = createReviewerClient({ userId: runUserId, config, judgeModel: actionsJudgeModel() }).catch(() => null);
	// APIs conectadas por OpenAPI (leitura). Falha ao carregar nunca derruba o run: segue sem elas.
	const apiConnectorPromise = loadApiConnectorRuntime(runUserId).catch((error) => {
		console.error(`load api connections failed run=${runId}`, error);
		return null;
	});
	// L10: config/provedores e mensagens/skills não dependem um do outro: em paralelo.
	const configStage = async () => {
		// Configuração da conta congelada ao assumir o run: retomada reusa o snapshot do
		// checkpoint, run novo resolve uma vez (usuário > env > padrão) com o dono do run.
		const { snapshot: configSnapshot } = await resolveRunConfigSnapshot({
			userId: runUserId,
			sandboxAutoStart: settings.sandboxAutoStart,
			restored: checkpoint?.configSnapshot,
		}, { loadConfig: () => accountConfigRead });
		const runtimeConfig = runtimeParamsFromSnapshot(configSnapshot);
	 const providers = createRunProviderServices({ userId: runUserId, conversationId: run.conversationId, policy: rawBotPolicy, chatgptEnabled: configSnapshot.chatgptEnabled, openRouterKey: Boolean(config.openRouterApiKey), accountDefaultModel: async () => (await loadAccountConfig())?.models?.default ?? null, onFallback: async notice => {
			await emit(notice);
			// Marcador persistido na conversa: sobrevive ao fim do run e a recarregar a thread.
			await persistConversationCardFromEvent(run.conversationId, notice, { runStartedAt: new Date(run.createdAt) }).catch((error) => console.error(`persist provider fallback card failed run=${runId}`, error));
		} });

		const canSeeUserImages = await providers.supportsImageInput(run.model);
		const openrouterVisionFallback = visionFallbackFromSnapshot(configSnapshot);
		const fallbackModel = openrouterVisionFallback && await providers.supportsImageInput(openrouterVisionFallback)
			? openrouterVisionFallback
			: undefined;
		const imageVision = imageVisionForRun({ userId: runUserId, apiKey, fallbackModel });
		return { configSnapshot, runtimeConfig, providers, canSeeUserImages, imageVision };
	};
	// Lições do bot injetadas no prompt estável deste run (para o inspetor); vazio na retomada (vêm do checkpoint).
	let startLessonIds: string[] = [];
	const messagesStage = async () => {
		const fresh = !checkpoint?.llmMessages?.length;
		// L10: o que não depende do histórico começa já, junto das leituras do histórico abaixo; cada
		// resultado é aplicado na mesma ordem de antes (as notas entram no prompt sempre na mesma posição).
		// Artefatos de runs anteriores (A2 step 3): apenas para run novo na mesma conversa.
		const artifactsPromise = fresh && run.conversationId && run.origin !== "routine"
			? listConversationArtifacts(runUserId, run.conversationId, { limit: 5, excludeRunId: runId }).then(
				(artifacts) => ({ ok: true as const, artifacts }),
				(error: unknown) => ({ ok: false as const, error }),
			)
			: null;
		// Tarefa ativa (bug #80): rotina/webhook ficam de fora (nunca viram "a tarefa").
		const taskContextPromise = fresh && run.conversationId && run.origin === "chat" && !groupRun
			? getConversationTaskContext(runUserId, run.conversationId, { excludeRunId: runId }).then(
				(context) => ({ ok: true as const, context }),
				(error: unknown) => ({ ok: false as const, error }),
			)
			: null;
		// `/skill` e `@Bot` digitados pelo usuário neste turno (só chat 1:1, run novo).
		const mentionsPromise = fresh && run.origin === "chat" && !groupRun && run.botId
			? buildMentionNotes({ userId: runUserId, botId: run.botId, text: run.objective, toolset: mcp?.toolset }).then(
				(turn) => ({ ok: true as const, turn }),
				(error: unknown) => ({ ok: false as const, error }),
			)
			: null;
		// Imagens de turnos anteriores vêm do que está persistido (dono validado no db), nunca de ids do cliente.
		const historyImagesPromise = fresh && run.conversationId && run.origin !== "routine"
			? loadUserImageHistory(run.conversationId, runUserId).catch((error) => {
				console.error(`load image history failed run=${runId}`, error);
				return [];
			})
			: Promise.resolve([]);
		// Arquivos anexados (PDF, Office, planilha, texto, zip...): conteúdo do pedido atual e lista da conversa.
		const attachmentsPromise = run.origin !== "routine"
			? attachmentRuntimeForRun({
				userId: runUserId,
				conversationId: run.conversationId,
				currentIds: checkpoint?.userFileArtifactIds ?? [],
				fresh,
				model: run.model,
			}).catch((error) => {
				console.error(`load attachments failed run=${runId}`, error);
				return null;
			})
			: Promise.resolve(null);
		// Índice das skills do dono (K1): só em run novo; na retomada o prompt vem do checkpoint.
		const skillIndexPromise = fresh ? loadRunSkillIndex({ userId: runUserId, botId: run.botId }) : Promise.resolve("");
		// Notas de pesquisa (F3) de runs anteriores da conversa: escopadas pelo dono da sessão; falha não derruba o run.
		const researchConversation = !groupRun && run.conversationId && (run.origin === "chat" || run.origin === "webhook") ? run.conversationId : null;
		const priorResearchNotesPromise = researchConversation
			? listConversationResearchNotes(runUserId, researchConversation, { excludeRunId: runId, origin: run.origin }).catch((error) => {
				console.error(`load research notes failed run=${runId}`, error);
				return [];
			})
			: Promise.resolve([]);
		// Ledger de itens (V3) de um run anterior da conversa: mesmo escopo de dono; falha não derruba o run.
		const priorTaskLedgerPromise = researchConversation
			? getConversationTaskLedger(runUserId, researchConversation, { excludeRunId: runId, origin: run.origin }).catch((error) => {
				console.error(`load task ledger failed run=${runId}`, error);
				return null;
			})
			: Promise.resolve(null);
		// Pedidos deste bot a outros bots ainda sem resposta (send_to_bot): bloco curto no prompt. Dono do run; falha = nenhum.
		const openBotRequestsPromise = !groupRun && run.botId && (run.origin === "chat" || run.origin === "bot")
			? listOpenBotRequests({ userId: runUserId, fromBotId: run.botId }).catch((error) => {
				console.error(`load open bot requests failed run=${runId}`, error);
				return [];
			})
			: Promise.resolve([]);
		// Lista de passos (update_task_list) da conversa: mesmo escopo de dono; falha não derruba o run.
		// Plano aprovado: os passos do plano semeiam a lista (o cartao aparece ja, antes do 1o passo).
		const seededTaskList = fresh ? checkpoint?.transcriptSeed?.taskList : undefined;
		const priorTaskListPromise = seededTaskList?.length
			? Promise.resolve(seededTaskList)
			: !groupRun && run.conversationId && run.origin === "chat"
				? getConversationTaskList(runUserId, run.conversationId, { excludeRunId: runId, origin: run.origin }).catch((error) => {
					console.error(`load task list failed run=${runId}`, error);
					return null;
				})
				: Promise.resolve(null);
		// Plano esperando aprovacao nesta conversa: escritas voltam com erro ate o usuario decidir.
		const planPendingPromise = !groupRun && run.conversationId && run.origin === "chat"
			? getSkillPendingIntent(runUserId, run.conversationId).then((pending) => pending?.payload.action === "plan", () => false)
			: Promise.resolve(false);

		// Fase 2 — ciclo limpo: modo congelado no checkpoint; em run fresco,
		// liga sozinho com resumo fresco (sem resumo não há ciclo). Rotina fora.
		// Memória da conversa da conta (Padrão quando ausente). Retomada mantém o modo já congelado no checkpoint.
		// Conversa contínua: a marca d'água é lida ANTES do histórico (o próximo turno lê só o que vier depois
		// dela); por isso sai junto da configuração da conta, antes de qualquer leitura do histórico.
		const watermarkPromise = fresh && run.conversationId && run.origin === "chat" && !groupRun && contextTranscriptEnabled()
			? getConversationWatermark(run.conversationId).catch((error) => {
				console.error(`load conversation watermark failed run=${runId}`, error);
				return null;
			})
			: Promise.resolve(null);
		const contextMemory = fresh ? (await loadAccountConfig())?.execution?.contextMemory : undefined;
		let compact = groupRun ? false : (checkpoint?.compact ?? false);
		let historyLimit = HISTORY_LIMIT_ECONOMY;
		if (
			!compact &&
			!groupRun &&
			fresh &&
			run.conversationId &&
			run.origin !== "routine"
		) {
			const hasFreshSummary = contextMemory === "economy"
				? (await getFreshSummary(run.conversationId).catch(() => null)) !== null
				: false;
			({ compact, limit: historyLimit } = historyWindowFor(contextMemory, hasFreshSummary));
		}
		const transcriptWatermark: TranscriptWatermark | undefined = (await watermarkPromise) ?? undefined;

		// Histórico de texto e conversa contínua (chamadas e resultados de ferramenta do run anterior) saem juntos.
		let inputMessages = checkpoint?.messages ?? [];
		const recentPromise = inputMessages.length === 0 && run.origin !== "routine" && run.conversationId
			? loadRecentConversationMessages(
				run.conversationId,
				compact ? COMPACT_TAIL_KEEP : historyLimit,
			)
			: null;
		// Falha do histórico derruba o run (como antes), mas só quando for aguardada abaixo.
		recentPromise?.catch(() => undefined);
		let transcriptOutcome: InspectContextPayload["transcript"] | undefined;
		const transcriptPromise: Promise<TranscriptHistory | null> = fresh && run.conversationId && run.origin === "chat"
			? resolveTranscriptHistory({
				enabled: contextTranscriptEnabled(),
				origin: run.origin,
				runId,
				conversationId: run.conversationId,
				groupRun: Boolean(groupRun),
				compact,
				model: run.model,
				objective: run.objective,
				seed: checkpoint?.transcriptSeed,
				report: (outcome) => {
					transcriptOutcome = outcome;
				},
				loadLatest: () => getConversationTranscript(runUserId, run.conversationId!, { excludeRunId: runId }),
				loadById: (fromRunId) => getRunTranscript(runUserId, run.conversationId!, fromRunId),
				loadAfter: (watermark, excludeRunId) => loadMessagesAfterWatermark(run.conversationId!, watermark, { excludeRunId }),
			}).catch((error) => {
				console.error(`load conversation transcript failed run=${runId}`, error);
				return null;
			})
			: Promise.resolve(null);
		if (inputMessages.length === 0) {
			// Rotina: NÃO carrega o histórico do chat — senão o modelo relê o
			// "cria um webhook…" original e tenta criar de novo a cada disparo.
			// Proativo de bot (bot-created) usa origin "chat", NUNCA
			// "routine": rotina stripa tools (computer-use.ts) e esvazia histórico
			// aqui; proativo precisa de tools + perfil/fatos via prepareMessages
			// (memory-context.ts) + instrução curta PT-BR per-evento em
			// messages[0].system (BOT_CONFIG_EVENT_SYSTEM_INSTRUCTION).
			if (run.origin === "routine") {
				if (run.objective.trim().length > 0) {
					inputMessages = [{ role: "user", content: run.objective }];
				}
			} else if (recentPromise) {
				const recent = await recentPromise;
				inputMessages = recent
					.filter((m): m is SessionMessage & { role: ChatMessage["role"] } =>
						isLlmChatRole(m.role),
					)
					.map((m) => ({
						role: m.role,
						content: m.content,
					}));
				inputMessages = appendObjective(inputMessages, run.objective);
			}
		}

		// Conversa contínua: o run novo parte das chamadas e resultados de ferramenta do anterior, não só do texto.
		// Qualquer falha ou divergência cai no histórico de texto de sempre.
		const transcript = await transcriptPromise;
		if (fresh && run.conversationId && run.origin === "chat") {
			// O resultado da aprovação já está na chamada pendente: o turno só leva a orientação, sem repeti-lo.
			const seed = checkpoint?.transcriptSeed;
			if (transcript?.seedApplied && seed) {
				const lastUser = inputMessages.map((m) => m.role).lastIndexOf("user");
				if (lastUser >= 0) inputMessages = inputMessages.map((m, i) => (i === lastUser ? { ...m, content: seed.shortContent } : m));
			}
		}

		let messages = !fresh
			? inputMessages
			: await prepareMessages(
					inputMessages,
					run.botId,
					run.conversationId,
					runUserId,
					compact,
					groupPrompt,
					transcript ? TRANSCRIPT_SLOT : undefined,
					true,
					(ids) => {
						startLessonIds = ids;
					},
				);

		// Injetar nota sobre artefatos de runs anteriores (A2 step 3): apenas para run novo
		// na mesma conversa que tem histórico de artefatos.
		if (artifactsPromise) {
			const loaded = await artifactsPromise;
			try {
				if (!loaded.ok) throw loaded.error;
				const artifactsNote = buildConversationArtifactsNote(loaded.artifacts);
				if (artifactsNote) {
					messages = appendTurnNote(messages, artifactsNote);
				}
			} catch (error) {
				console.error(`load conversation artifacts failed run=${runId}`, error);
				// Não falha o run; apenas segue sem a nota.
			}
		}

		// Tarefa ativa (bug #80): as últimas tarefas do usuário e os recursos que criaram, do banco.
		// Sobrevive à compactação do histórico; rotina/webhook ficam de fora (nunca viram "a tarefa").
		if (taskContextPromise) {
			const loaded = await taskContextPromise;
			try {
				if (!loaded.ok) throw loaded.error;
				const taskNote = buildConversationTaskNote(loaded.context);
				if (taskNote) messages = appendTurnNote(messages, { role: "system", content: taskNote });
			} catch (error) {
				console.error(`load conversation task context failed run=${runId}`, error);
			}
		}

		// `/skill` e `@Bot` digitados pelo usuário neste turno (só chat 1:1, run novo): a skill já vem
		// carregada e os bots citados chegam com id. Falha não derruba o run.
		let forcedConnectors: string[] = [];
		let carriedNotes: CarriedNote[] = [];
		if (mentionsPromise) {
			const loaded = await mentionsPromise;
			try {
				if (!loaded.ok) throw loaded.error;
				const turn = loaded.turn;
				// Notas de turnos anteriores que definem a tarefa em andamento voltam (antes das deste turno).
				const merged = contextTranscriptEnabled() ? mergeCarriedNotes(transcript?.carriedNotes, turn.notes) : { carried: [], reinject: [] };
				carriedNotes = merged.carried;
				// A nota já está na conversa levada (gravada como foi enviada): só volta se um resumo a tirou de lá.
				const alreadyThere = new Set((transcript?.priorTranscript ?? []).filter((message) => message.role === "system" && typeof message.content === "string").map((message) => message.content as string));
				for (const note of merged.reinject) if (!alreadyThere.has(note.content)) messages = appendTurnNote(messages, { role: "system", content: note.content });
				for (const note of turn.notes) messages = appendTurnNote(messages, { role: "system", content: note });
				forcedConnectors = turn.connectors;
			} catch (error) {
				console.error(`load composer mentions failed run=${runId}`, error);
			}
		}

		const [historyImages, attachmentsForRun, skillIndex, priorResearchNotes, priorTaskLedger, openBotRequests, priorTaskList, planPending] = await Promise.all([
			historyImagesPromise,
			attachmentsPromise,
			skillIndexPromise,
			priorResearchNotesPromise,
			priorTaskLedgerPromise,
			openBotRequestsPromise,
			priorTaskListPromise,
			planPendingPromise,
		]);
		if (attachmentsForRun?.historyNote) messages = appendTurnNote(messages, { role: "system", content: attachmentsForRun.historyNote });

		if (seededTaskList?.length && run.conversationId) {
			await upsertTaskListCard(run.conversationId, runId, seededTaskList).catch(() => undefined);
			await appendRunEvent(runId, "task_list", { type: "task_list", items: seededTaskList, runId }).catch(() => undefined);
		}

		return { planPending, messages, inputMessages, transcriptOutcome, priorTranscript: transcript?.priorTranscript, transcriptWatermark, carriedNotes, priorLoadedTools: transcript?.loadedTools, priorToolCache: transcript?.toolCache, priorCompaction: transcript?.compaction, historyImages, skillIndex, forcedConnectors, priorResearchNotes, priorTaskLedger, priorTaskList, openBotRequests, attachments: attachmentsForRun?.runtime };
	};
	const [{ configSnapshot, runtimeConfig, providers, canSeeUserImages, imageVision }, { planPending, messages, inputMessages, transcriptOutcome, priorTranscript, transcriptWatermark, carriedNotes, priorLoadedTools, priorToolCache, priorCompaction, historyImages, skillIndex, forcedConnectors, priorResearchNotes, priorTaskLedger, priorTaskList, openBotRequests, attachments }] =
		await Promise.all([configStage(), messagesStage()]);
	// Inspetor: como o histórico deste turno foi montado (só metadados; nunca o texto).
	if (transcriptOutcome) {
		const payload: InspectContextPayload = { type: "inspect_context", transcript: transcriptOutcome };
		await appendRunEvent(runId, "inspect_context", payload).catch(() => undefined);
	}

	const emailContext = await emailContextPromise;
	// Lições (playbook do bot): todas as ativas vão ao runtime (conector/tool entram ao carregar; `lesson_feedback` conta o uso).
	const runLessons = await runLessonsPromise;
	if (!checkpoint?.llmMessages?.length && (startLessonIds.length > 0 || run.conversationId)) {
		// Inspetor: o que foi injetado no início e o resultado da última revisão de lições (ação "no run seguinte").
		const last = await latestLessonReviewPromise;
		const review = last && last.payload && typeof last.payload === "object" ? (last.payload as Record<string, unknown>) : null;
		const reviewed = review && review.status && review.status !== "covered";
		if (startLessonIds.length > 0 || reviewed) {
			const payload: InspectLessonsPayload = {
				type: "inspect_lessons",
				injected: startLessonIds,
				...(reviewed && last
					? { review: { runId: last.runId, at: last.createdAt, status: String(review!.status), ...pickReviewCounts(review!) } }
					: {}),
			};
			await appendRunEvent(runId, "inspect_lessons", payload).catch(() => undefined);
		}
	}

	let cachedSessionId: string | null =
		checkpoint?.sandboxSessionId ?? run.sandboxSessionId;
	// Última sessão anunciada ao painel neste run: o reaproveitamento de uma sessão
	// herdada (checkpoint/run) também emite `session`, para o viewer seguir a VM certa.
	let announcedSessionId: string | null = null;

	// Orçamento: request (budgetJson) > bot (policyJson) > conta > padrões.

	const botPolicy = parseBudgetPolicy(rawBotPolicy);
	const proactiveBot = await proactiveBotPromise;
	const accountTimezone = proactiveBot?.isPrimary === true
		? (await loadAccountConfig())?.general?.timezone
		: undefined;
	const proactiveForRun = resolveProactiveForRun({
		accountTimezone,
		origin: run.origin,
		isGroupRun: Boolean(groupRun),
		isPrimary: proactiveBot?.isPrimary === true,
		policyJson: rawBotPolicy,
	});
	const routineNotify = await routineNotifyPromise;
	const routinePageId = await routinePageIdPromise;
	const userPushZone = (run.origin === "routine" && routineNotify === "important") || run.origin === "chat"
		? (proactiveBot?.isPrimary === true ? accountTimezone : (await loadAccountConfig())?.general?.timezone)
		: undefined;
	const userPushForRun = resolveUserPushForRun({
		origin: run.origin,
		isGroupRun: Boolean(groupRun),
		hasConversation: Boolean(run.conversationId),
		routineNotify,
		policyJson: rawBotPolicy,
		accountTimezone: userPushZone,
		send: deps.notify ? async (text) => { await deps.notify!(runUserId, run.conversationId!, "reminder", text); } : undefined,
	});
	const requestBudget = parseBudgetPolicy(run.budgetJson ?? null);
	const autoContinueAttempt = readAutoContinueAttempt(run.budgetJson);
	const budget = resolveBudget({
		maxSteps: run.maxSteps,
		policy: { ...accountBudgetPolicy(configSnapshot, run.maxSteps), ...botPolicy, ...requestBudget },
	});
	const effectiveCostCap = effectiveCostCapUsd(budget.maxCostUsd, configSnapshot);
	const runStartedAt = run.startedAt
		? new Date(run.startedAt).getTime()
		: Date.now();
	// Sessão herdada (checkpoint/run): a conferência de que ainda roda corre em segundo plano, fora do
	// caminho até a 1ª chamada ao modelo. Quem lê `cachedSessionId` (pedir a sessão, gravar progresso ou
	// o fim do run) espera por ela antes; a sessão morta continua sendo trocada/limpa como antes.
	let sessionProbe: Promise<void> = Promise.resolve();
	if (cachedSessionId) {
		// Mesmo prazo do runtime: só tempo ativo (pausa e fila não contam).
		const { deadlineAtMs } = wallClockAnchors({ maxWallMs: budget.maxWallMs, now: Date.now(), runStartedAt, restored: checkpoint });
		const initialContext = { signal: aborter.signal, deadlineAtMs };
		const inherited = cachedSessionId;
		// `getRunningSession` nunca rejeita (falha = sessão não está rodando).
		sessionProbe = getRunningSessionId(manager.withExecutionContext?.(initialContext) ?? manager, inherited).then((running) => {
			// Só troca se ninguém mexeu nela enquanto isso (ex.: erro de sandbox já a descartou).
			if (cachedSessionId === inherited) cachedSessionId = running;
		});
		aborter.signal.throwIfAborted();
	}

	const persistCheckpoint = async (next: AgentRunCheckpoint) => {
		await sessionProbe;
		try {
			await persistRunProgress({
				runId,
				checkpoint: withConfigSnapshot(next, configSnapshot),
				sandboxSessionId: cachedSessionId,
				consumedInputIds: next.consumedInputIds,
				lease,
			});
		} catch (error) {
			asLeaseError(error);
		}
	};

	const getSessionId = async (execution: { signal?: AbortSignal; deadlineAtMs?: number } = {}): Promise<string> => {
		const scopedManager = manager.withExecutionContext?.(execution) ?? manager;
		if (guards.isLeaseLost()) throw new LeaseLostError();
		await sessionProbe;
		if (cachedSessionId) {
			const running = await getRunningSession(scopedManager, cachedSessionId);
			if (running) {
				if (announcedSessionId !== running.sessionId) {
					announcedSessionId = running.sessionId;
					await appendRunEvent(runId, "session", {
						type: "session",
						sessionId: running.sessionId,
						viewerUrl: running.viewerUrl,
					});
				}
				return running.sessionId;
			}
			console.warn(`[sandbox] session ${cachedSessionId} run=${runId} is no longer running; resolving another for the conversation`);
			cachedSessionId = null;
		}
		if (!configSnapshot.sandboxAutoStart) {
			throw new Error("Sandbox desativado nas configurações");
		}
		// Grupo: cada membro usa a VM da própria conversa, nunca uma VM compartilhada do grupo.
		const session = await scopedManager.resolveSession((groupRun?.selfConversationId ?? run.conversationId) ?? undefined);
		execution.signal?.throwIfAborted();
		cachedSessionId = session.sessionId;
		announcedSessionId = session.sessionId;
		// W4: só a sessão; o resto do checkpoint (orçamento, tetos, login pendente)
		// fica como está. Idempotente: regravar a mesma sessão é no-op.
		try {
			await setRunSandboxSession(runId, session.sessionId, lease);
		} catch (error) {
			asLeaseError(error);
		}
		await appendRunEvent(runId, "session", {
			type: "session",
			sessionId: session.sessionId,
			viewerUrl: session.viewerUrl,
		});
		return session.sessionId;
	};

	const coalescer = createRunEventCoalescer(async (event) => {
		await appendRunEvent(runId, event.type, event);
		// Hub em tempo real: andamento do run (sem texto) para listas e outras conversas, no máximo a cada poucos segundos.
		if (runActivityThrottle(runId)) {
			void publishUserEvent(runUserId, "run-activity", { runId, conversationId: run.conversationId, botId: run.botId, kind: event.type });
		}
	});
	const emitState = { tail: Promise.resolve() };
	const emit = (event: ComputerUseEvent) => {
		emitState.tail = coalescer.push(event).catch((error) => {
			console.error(`append run event failed run=${runId}`, error);
			throw error;
		});
		return emitState.tail;
	};

	// Falas do assistente no meio do run (resposta da triagem, texto de passo com tools) entram na conversa na
	// hora em que acontecem; só chat comum (rotina/bot/webhook mantêm o texto único do fim do run).
	const segmentRecorder = run.conversationId && run.origin === "chat"
		? createAssistantSegmentRecorder({
				write: async (text, createdAt) => {
					await appendRunAssistantSegment(run.conversationId!, text, { createdAt });
				},
				// Rascunho revisado gravado recolhido: recarregar mostra o mesmo que o ao vivo (o card corta o texto).
				writeDraft: async (text, reason, createdAt) => {
					await appendConversationCard(run.conversationId!, { v: 1, kind: "revised-draft", text: text.slice(0, REVISED_DRAFT_MAX_CHARS), reason }, { createdAt });
				},
			})
		: null;
	// Resultados de ferramentas do run: a revisão de memória salva fatos que só apareceram por tool (ex.: CNPJ do ERP).
	const toolResultsForReview: Array<{ name: string; ok: boolean; summary: string }> = [];
	const emitWithSegments = async (event: ComputerUseEvent) => {
		if (event.type === "tool_result") toolResultsForReview.push({ name: event.name, ok: event.ok, summary: event.summary });
		await segmentRecorder?.observe(event);
		return emit(event);
	};

	// Cancelamento e pausa dividem uma leitura (L10).
	const control = createRunControlReader({ read: () => getRunControlState(runId) });

	// Rotina de alerta: o run só verifica a condição; o aviso (com debounce) é decidido aqui, depois do veredito.
	const alertCtx = await alertCtxPromise;
	const alertRun = alertCtx ? { condition: alertCtx.alert.condition, ...(alertCtx.alert.hint ? { hint: alertCtx.alert.hint } : {}), report: { verdict: null as AlertVerdict | null } } : undefined;

	let completionPersisted: "completed" | "budget_exhausted" | null = null;
	const messageTriageModel = await messageTriageModelPromise;
	const reviewer = await reviewerPromise;
	// Entrega offline: com nota de ausência, o fim do run coloca o resultado no backlog.
	const settleDelivery = (end: RunEnd, resultText?: string | null) =>
		settleRunDelivery(
			{ userId: runUserId, runId, end, resultText },
			{ markReady: markDeliveryReady, cancel: cancelRunDelivery },
		);
	const apiConnector = await apiConnectorPromise;
	try {
		const result = await runComputerUse({
			messageTriageModel,
			onAwayNote: createAwayNoteHandler({
				userId: runUserId,
				runId,
				conversationId: run.conversationId,
				record: recordAwayNote,
			}),
			// "Depois": vira entrada queue deste run; chainRunFollowUp a encadeia ao concluir.
			queueFollowUp: async (instruction, key) => {
				await createRunInput(runId, laterFollowUpInput(instruction, key), runUserId);
			},
			manager,
			mcp,
			apiConnector,
			...(deps.enqueueConnectorLesson
				? { onConnectorLesson: (lesson: { kind: "mcp" | "api"; connectionId: string; failed: ConnectorLessonJobPayload["failed"]; succeeded: ConnectorLessonJobPayload["succeeded"] }) => deps.enqueueConnectorLesson!({ ...lesson, userId: runUserId, ...(run.botId ? { botId: run.botId } : {}) }) }
				: {}),
			email: emailContext,
			// `@App` do usuário neste turno: as tools desses conectores já entram no 1º passo.
			forcedConnectors: forcedConnectors.length > 0 ? forcedConnectors : undefined,
			// Verificação de pendências da reflexão: só leitura (nativa ou conector que se declara somente leitura).
			toolFilter: isRecheckObjective(run.origin, run.objective)
				? (toolName: string) => isRecheckToolAllowed(toolName, mcp?.toolset.entries.get(toolName)?.readOnly)
				: undefined,
			autonomy,
			skillIndex,
			...(runLessons.length > 0 && run.botId
				? {
						lessons: {
							items: runLessons,
							onInjected: ({ ids, key }: { ids: string[]; key: string }) => {
								const payload: InspectLessonsPayload = { type: "inspect_lessons", injected: ids, key };
								void appendRunEvent(runId, "inspect_lessons", payload).catch(() => undefined);
							},
							recordFeedback: (entries: LessonFeedbackEntry[]) => recordLessonFeedback(runUserId, run.botId!, entries),
						},
					}
				: {}),
			proactive: proactiveForRun,
			// Alerta não usa o `notify_user` da rotina "só importante": o veredito é o único aviso.
			userPush: alertRun ? undefined : userPushForRun,
			alertRun,
			jevMcpMode: runtimeConfig.jevMcpMode,
			executionDiscipline: runtimeConfig.executionDiscipline,
			contextEconomy: runtimeConfig.contextEconomy,
			contextMemory: runtimeConfig.contextMemory,
			maxOutputTokens: runtimeConfig.maxOutputTokens,
			toolResultMaxChars: runtimeConfig.toolResultMaxChars,
			modelCallTimeoutMs: runtimeConfig.modelCallTimeoutMs,
			firstEventTimeoutMs: runtimeConfig.firstEventTimeoutMs,
			idleTimeoutMs: runtimeConfig.idleTimeoutMs,
			fallbackModels: runtimeConfig.fallbackModels,
			imageModel: runtimeConfig.imageModel,
			evaluateMcpWithJev: reviewer?.available ? (state, signal) => reviewer.evaluateMcp(state, signal) : undefined,
			jev: reviewer?.available
				? {
						modes: { ...runtimeConfig.jevModes, proactive: proactiveJevMode(runtimeConfig.jevModes?.intent), pending: pendingJevMode(runtimeConfig.jevModes?.intent), actions: actionsJevMode() },
						// F0: duração/modelo/tokens por decisão, fora do uso principal.
						onDecision: (record) => jevTelemetry.record(record),
						// Verificador de ações: o modelo rápido devolve JSON (veredito + motivo) em texto.
						complete: reviewer.complete,
						ask: reviewer.ask,
					}
				: undefined,
			getSessionId,
			sandboxEnabled: runtimeConfig.sandboxEnabled,
			model: run.model,
			streamChat: providers.streamChat,
			// Modelo dos subagentes do bot (null = igual ao do run).
			subagentModel: readSubagentModel(rawBotPolicy),
			// Modelo para código (bot > conta), já conferido contra os provedores do usuário.
			codingModel: await resolveRunCodingModel({
				botPolicy: rawBotPolicy,
				snapshot: configSnapshot,
				runModel: run.model,
				openRouterKey: Boolean(config.openRouterApiKey),
				isKnown: providers.isKnown,
			}),
			// Modo Automático: modelos por dificuldade (conta + bot), só os que o usuário consegue usar.
			modelTiers: await resolveRunModelTiers({
				auto: readRunModelAuto(run),
				botPolicy: rawBotPolicy,
				snapshot: configSnapshot,
				openRouterKey: Boolean(config.openRouterApiKey),
				isKnown: providers.isKnown,
			}),
			isKnownModel: async id => (await providers.isKnown(id)) !== false,
			getModelContextLength: providers.contextLength,
			apiKey,
			messages,
			language,
			botId: run.botId ?? undefined,
			userId: runUserId,
			conversationId: run.conversationId ?? undefined,
			runId,
			origin: run.origin,
			...(routinePageId ? { routinePageId } : {}),
			objective: run.objective,
			maxSteps: run.maxSteps,
			// Janela gravada na criação (API); desconhecida = fallback 128k.
			contextLength: parseModelRef(run.model).provider !== "openrouter" ? (await providers.contextLength(run.model)) ?? 64000 : readRunContextLength(run),
			// Retomada automática só no 1o fechamento por teto de passos de um run do usuário ou das retomadas anteriores.
			autoContinue: { canSchedule: Boolean(deps.enqueueNextRun) && run.origin === "chat" && autoContinueAttempt < AUTO_CONTINUE_MAX },
			// Teto de custo: o menor entre o do pedido/bot (nas retomadas, só o que sobrou dele) e o da conta.
			budget: runtimeBudgetParams(budget, effectiveCostCap),
			runStartedAt,
			onEvent: emitWithSegments,
			restoredCheckpoint: checkpoint,
			abortSignal: aborter.signal,
		shouldContinue: async () => {
			if (guards.isLeaseLost()) throw new LeaseLostError();
			if (aborter.signal.aborted) {
				throw errorFromAbortSignal(aborter.signal);
			}
			if ((await control.get()).cancelRequested) {
				throw new AgentRunCancelledError();
			}
			return true;
		},
		shouldPause: async () => (await control.get()).pauseRequested,
			loadScreenshot: loadScreenshotArtifact,
			userImageArtifactIds: checkpoint?.userImageArtifactIds,
			historyImages,
			priorTranscript,
			transcriptWatermark,
			carriedNotes,
			priorLoadedTools,
			priorToolCache,
			priorCompaction,
			priorResearchNotes,
			priorTaskLedger,
			priorTaskList,
			openBotRequests,
			planMode: readPlanMode(rawBotPolicy),
			planPending,
			onInspect: (payload: InspectHooksPayload) => { void appendRunEvent(runId, "inspect_hooks", payload).catch(() => undefined); },
			canSeeUserImages,
			loadUserImage: imageVision.loadUserImage,
			describeUserImage: imageVision.describeUserImage,
			attachments,
			persistScreenshot: (pngBase64) =>
				persistScreenshotArtifact({ runId, pngBase64 }),
			findCompletedTool: (key) => findCompletedToolStep(runId, key),
			findStartedTool: (key) => findStartedToolStep(runId, key),
			// F12/B5: login pedido ao usuário → run fica "paused" (retoma pelo
			// /resume do card "Terminei", do mesmo checkpoint).
			onLoginRequired: async () => {
				await requestPauseAgentRun(runId);
			},
			onSandboxError: () => {
				// Sessão pode ter morrido (reaper/container); força re-resolve
				// (adopt-by-label ou cria nova) na próxima tool em vez de
				// repetir na porta velha até o maxSteps.
				cachedSessionId = null;
			},
			consumeSteerInputs: async () => {
				const pending = await listPendingSteerInputs(runId);
				return pending.map((item) => ({
					id: item.id,
					content: item.content,
					mode: item.mode,
					attachments: item.attachments,
				}));
			},
			// F1: `interrupt` pendente aborta a chamada ao modelo em voo (o runtime filtra os já consumidos).
			peekInterruptInputs: () => listPendingInterruptInputIds(runId),
			onRunSignal: deps.subscribeRunSignals
				? (onSignal) => deps.subscribeRunSignals!(runId, onSignal)
				: undefined,
			// Triagem ao vivo com `cancel`: mesmo caminho do "Parar" (o poll do lease aborta o run).
			requestCancel: () => requestCancelAgentRun(runId).then(() => undefined),
			onStep: async (step) => {
				runTelemetry.onStep(step);
				try {
					const telemetry = stepTelemetryFields(step);
					await appendAgentStep({
						runId,
						decisionIndex: step.decisionIndex,
						subIndex: step.subIndex,
						type: step.type,
						status: step.status,
						inputJson: step.inputJson,
						outputJson: telemetry.outputJson,
						idempotencyKey: step.idempotencyKey,
						tokens: step.tokens,
						durationMs: telemetry.durationMs,
						costUsd: telemetry.costUsd,
						lease,
					});
				} catch (error) {
					asLeaseError(error);
				}
			},
			onCheckpoint: persistCheckpoint,
			onRoutineMutated: deps.onRoutineMutated,
			// Conversa entre bots: o runtime só expõe send_to_bot com 2+ bots do dono.
			// No grupo o canal é a conversa (menção @Nome); send_to_bot fica de fora.
			listBotRoster: groupRun ? undefined : listUserBotRoster,
			decideForOtherBots: readDecideForOtherBots(rawBotPolicy),
			// Checagens que só observam a resposta final não seguram a conclusão: o uso delas é somado depois (abaixo).
			backgroundObserveChecks: true,
		});
		runTelemetry.markRuntimeDone();
		await coalescer.flush();
		await emitState.tail;

		if (result.hitWall) {
			await emit({
				type: "status",
				status: "budget_exhausted",
				detail: `Alcancei o limite de ${budget.hardMaxSteps} passos (${usageText(result.usage)}). A resposta acima é o melhor que apurei.`,
			});
			await emitState.tail;
		}

		runTelemetry.markBeforeFinalWrite();
		// Alerta: o texto do run é o resultado da verificação; só entra na conversa quando avisa.
		const alertPlan = alertCtx && alertRun
			? planAlertRun({ alert: alertCtx.alert, routineName: alertCtx.name, verdict: alertRun.report.verdict, modelText: result.text, interval: alertCtx.interval ?? null, now: new Date() })
			: null;
		// Verificação de follow-up sem novidade ([NO_UPDATE]): nada entra na conversa, sem push e sem revisão de memória.
		const noUpdate = run.origin === "proactive" && isNoUpdateReply(result.text);
		const resultText = alertPlan ? alertPlan.text : result.text;
		const resultConversationId = (alertPlan && !alertPlan.notify) || noUpdate ? null : run.conversationId;
		const jevAtCompletion = jevTelemetry.snapshot();
		await sessionProbe;
		await completeAgentRunAtomically({
			runId,
			conversationId: resultConversationId,
			assistantText: resultText,
			sandboxSessionId: cachedSessionId,
			lease,
			status: result.hitWall ? "budget_exhausted" : "completed",
			// Telemetria só no usageJson persistido; o evento `done` (UI) não a leva.
			usage: withRunTelemetry(result.usage, runTelemetry.meta(jevAtCompletion)),
			donePayload: {
				type: "done",
				message: { role: "assistant", content: resultText },
				model: result.model,
				usage: result.usage,
			},
		});
		// Daqui em diante a conclusão é irrevogável (ver catch).
		completionPersisted = result.hitWall ? "budget_exhausted" : "completed";
		// Estado do alerta + push `alert` (só na virada). Fora do caminho do run: nunca derruba a conclusão.
		if (alertPlan && alertCtx) {
			await settleAlertRun(
				alertPlan,
				{ userId: runUserId, routineId: alertCtx.routineId, conversationId: run.conversationId },
				{
					record: recordRoutineAlertState,
					reschedule: async () => {
						const updated = await getRoutine(runUserId, alertCtx.botId, alertCtx.routineId);
						if (updated) await deps.onRoutineMutated?.(updated);
					},
					push: deps.notify ? (userId, conversationId, text) => deps.notify!(userId, conversationId, "alert", text) : undefined,
				},
			).catch((error) => console.error(`[alert] liquidação falhou run=${runId}`, error));
		}

		// Ordem na thread: o card do questionário foi gravado durante o run e
		// a saudação/confirmação só na conclusão — sem o toque, o card fica
		// acima da saudação (invertido). Best effort, nunca quebra o run.
		// O questionnaireId é determinístico por run (ver runtime).
		if (run.conversationId && !noUpdate && result.text.trim().length > 0) {
			await touchQuestionnaireCard(
				run.conversationId,
				`questionnaire-${runId}`,
			).catch(() => undefined);
			await touchBotProfileCard(
				run.conversationId,
				`profile-${runId}`,
			).catch(() => undefined);
		}

		// Fallback de boas-vindas: o modelo saudou mas não chamou
		// propose_questionnaire — garante 1 pergunta padrão (gravada depois
		// da saudação, então já nasce na ordem certa). Best effort.
		if (
			run.conversationId &&
			!result.hitWall &&
			(run.objective ?? "").includes("[bot-created]")
		) {
			try {
				if (!(await hasPendingQuestionnaireCard(run.conversationId))) {
					const botName = (await getBotName(run.botId, runUserId)) ?? "bot";
					await appendConversationCard(run.conversationId, {
						v: 1,
						kind: "questionnaire" as const,
						questionnaireId: `questionnaire-${runId}`,
						title: `Configuração inicial do ${botName}`,
						description: "Vamos definir o papel principal do bot.",
						items: [
							{
								name: "papel",
								prompt: `Qual deve ser o principal papel do ${botName}?`,
								description: "Escolha a função que melhor representa o bot.",
								required: true,
								choices: [
									{
										value: "pessoal",
										label: "Assistente pessoal",
										description:
											"Ajuda com organização, decisões e tarefas do dia a dia.",
									},
									{
										value: "pesquisa",
										label: "Pesquisa e informação",
										description: "Busca, compara e resume informações.",
									},
									{
										value: "produtividade",
										label: "Produtividade",
										description: "Ajuda a planejar tarefas, prazos e rotinas.",
									},
									{
										value: "atendimento",
										label: "Atendimento",
										description: "Responde dúvidas e orienta usuários.",
									},
								],
								input: {
									label: "Outro papel",
									placeholder: "Descreva o papel",
								},
							},
						],
						status: "pending" as const,
					});
				}
			} catch {
				// fallback é garantia de UX, não parte do run
			}
		}

		// Onboarding do bot: as respostas descrevem o próprio bot (papel/tom), que já vai para o perfil; a revisão
		// pós-conversa as gravaria como memória (inclusive no perfil do usuário), então não roda.
		const onboardingRun = inputMessages.some((message) => message.role === "user" && parseQuestionnaireAnsweredContent(message.content)?.purpose === "onboarding");

		// Manutenção pós-conclusão (W6): o run já está concluído e é irrevogável.
		// Falha de Redis/db aqui só é logada: nunca emite erro nem marca o run como
		// falho (o catch abaixo também respeita `completionPersisted`).
		const toolNotes = buildToolResultNotes(toolResultsForReview);
		// Checagens de observação que terminaram depois da conclusão: o uso (e a decisão do Jev) entram no
		// usageJson do run quando elas terminam. Nunca rejeita; a reconciliação de custo espera por isto
		// para as duas gravações do usageJson não se atropelarem.
		const observeChecksRecorded = recordObserveChecks(
			{
				runId,
				userId: runUserId,
				observeChecks: result.observeChecks,
				jevCallsAtCompletion: jevAtCompletion?.calls ?? 0,
				jevSnapshot: () => jevTelemetry.snapshot(),
				meta: (jev) => runTelemetry.meta(jev),
				hasUsage: Boolean(result.usage),
			},
			{ addLateRunUsage },
		);
		await runPostCompletionSteps(runId, [
			{ name: "observe-checks", run: () => observeChecksRecorded },
			{
				name: "memory-review",
				run:
					// Grupo: a conversa dele só vira memória do bot se o próprio bot salvar (tool memory) no run.
					deps.enqueueMemoryReview && run.conversationId && !noUpdate && !groupRun && !onboardingRun
						? () =>
								deps.enqueueMemoryReview!({
									userId: runUserId,
									botId: run.botId ?? undefined,
									conversationId: run.conversationId!,
									messages: [
										...inputMessages,
										{ role: "assistant", content: result.text },
									],
									...(toolNotes.length > 0 ? { toolNotes } : {}),
								})
						: undefined,
			},
			{
				// Aprendizado (sleep-time): fora do caminho da resposta; o job só age se houver sinal e tem debounce por conversa.
				name: "lesson-review",
				run: deps.enqueueLessonReview
					? async () => {
							const failedToolCalls = await countFailedToolResults(runId).catch(() => 0);
							const proceed = shouldReviewLessons({
								origin: run.origin,
								hasBot: Boolean(run.botId),
								hasConversation: Boolean(run.conversationId),
								groupRun: Boolean(groupRun),
								onboardingRun,
								priorAssistantTurn: inputMessages.slice(0, -1).some((message) => message.role === "assistant"),
								failedToolCalls,
							});
							if (!proceed) return;
							await deps.enqueueLessonReview!({ userId: runUserId, botId: run.botId!, conversationId: run.conversationId!, runId, since: new Date(run.createdAt).toISOString() });
						}
					: undefined,
			},
			{
				// Aprendizado procedural: tarefa de vários passos que deu certo pode virar (ou refinar) uma skill.
				// A decisão barata (contagens) fica aqui; o job confere com os dados completos e só então chama o modelo.
				name: "skill-review",
				run: deps.enqueueSkillReview
					? async () => {
							const [completedToolCalls, failedToolCalls] = await Promise.all([
								countCompletedToolResults(runId).catch(() => 0),
								countFailedToolResults(runId).catch(() => 0),
							]);
							const proceed = shouldReviewForSkill({
								origin: run.origin,
								hasBot: Boolean(run.botId),
								hasConversation: Boolean(run.conversationId),
								groupRun: Boolean(groupRun),
								onboardingRun,
								hitWall: Boolean(result.hitWall),
								completedToolCalls,
								failedToolCalls,
							});
							if (!proceed) return;
							await deps.enqueueSkillReview!({ userId: runUserId, botId: run.botId!, conversationId: run.conversationId!, runId });
						}
					: undefined,
			},
			{
				// Custo que o OpenRouter não informou: consulta depois pelo id da geração.
				// Fora do caminho do run (não espera) e sem nunca falhar.
				name: "cost-reconcile",
				run: async () => {
					void observeChecksRecorded
						.then(() =>
							reconcileRunCosts(
								{ runId, userId: runUserId, apiKey },
								{ listMissing: listStepsMissingCost, apply: applyReconciledStepCost },
							),
						)
						.catch(() => undefined);
				},
			},
			{ name: "follow-up", run: () => chainRunFollowUp(run, runUserId, deps) },
			{ name: "delivery", run: () => settleDelivery(result.hitWall ? "budget_exhausted" : "completed", noUpdate ? null : result.text) },
			{
				// Push: terminou (ou lembrete/rotina). O notify cuida de switch do bot, "está olhando", protocolo e coalescência.
				name: "push",
				run: shouldPushRunEnd(run, result.text, Boolean(deps.notify), routineNotify, Boolean(alertCtx) || noUpdate) ? () => deps.notify!(runUserId, run.conversationId!, pushKindForOrigin(run.origin), result.text) : undefined,
			},
		]);

		return {
			runId,
			status: result.hitWall ? "budget_exhausted" : "completed",
			resultText: result.text,
		};
	} catch (error) {
		if (completionPersisted) {
			// W6: concluído e persistido. Nada aqui pode refazer, emitir erro nem
			// marcar o run como falho; só registra e devolve o resultado.
			console.error(`post-completion failure ignored run=${runId}`, error);
			return { runId, status: completionPersisted };
		}
		// A sessão herdada gravada no fim do run é a conferida (nunca rejeita).
		await sessionProbe;
		if (error instanceof AgentRunPausedError) {
			await emit({ type: "paused", reason: error.message });
			await coalescer.flush();
			await emitState.tail;
			await releasePausedRunLease(runId, lease);
			return { runId, status: "paused" };
		}
		if (error instanceof AgentRunCancelledError) {
			await emit({ type: "cancelled", reason: error.message });
			await coalescer.flush();
			await emitState.tail;
			await finishAgentRun(runId, {
				status: "cancelled",
				error: "cancelled",
				sandboxSessionId: cachedSessionId,
				lease,
			}).catch((finishError) => asLeaseError(finishError));
			await settleDelivery("cancelled");
			// Entradas que chegaram antes da parada e nunca foram consumidas viram o próximo turno.
			await chainRunFollowUp(run, runUserId, deps);
			return { runId, status: "cancelled" };
		}

		if (error instanceof BudgetExhaustedError) {
			// Teto de passos com progresso: retoma sozinho (limitado) em vez de pedir "responda continuar".
			const costCapUsd = effectiveCostCap;
			const autoIo = deps.autoContinueIo ?? createAutoContinueIo(deps.enqueueNextRun);
			const autoPlan = deps.enqueueNextRun || deps.autoContinueIo
				? await planAutoContinue(run, { cause: autoContinueCauseOfBudgetStop(error), progress: error.okToolCalls ?? 0, costCapUsd, costUsedUsd: error.usage?.costUsd }, autoIo).catch((planError): AutoContinueDecision => {
						console.error(`auto-continue plan failed run=${runId}`, planError);
						return { schedule: false, reason: "not_recoverable" };
					})
				: ({ schedule: false, reason: "not_recoverable" } as AutoContinueDecision);
			// Fechamento adiado pelo runtime e a retomada não vai acontecer: volta ao fechamento padrão.
			const closingText = error.finalText ?? (error.deferredClosing ? budgetStopFallbackText(error.message) : error.message);
			const resultText = autoPlan.schedule ? AUTO_CONTINUE_STATUS_TEXT : closingText;
			if (!autoPlan.schedule) await emit({ type: "error", error: error.message });
			await coalescer.flush();
			await emitState.tail;
			await finishAgentRun(runId, {
				status: "budget_exhausted",
				error: error.message,
				// Resumo final do modelo (chamada sem tools), se houve; senão o erro.
				resultText,
				usage: error.usage,
				sandboxSessionId: cachedSessionId,
				lease,
			}).catch((finishError) => asLeaseError(finishError));
			if (autoPlan.schedule) {
				// A entrega ao usuário fica para o fim da retomada; aqui não há nada a avisar.
				await settleDelivery("cancelled");
				const outcome = await scheduleAutoContinue(run, runUserId, autoPlan, autoIo);
				if (autoContinueScheduled(outcome)) return { runId, status: "budget_exhausted" };
				// A retomada não saiu do papel: o usuário recebe o fechamento comum em vez de ficar esperando.
				if (run.conversationId) await appendConversationMessage(run.conversationId, "assistant", budgetStopFallbackText(error.message)).catch(() => undefined);
			}
			if (!autoPlan.schedule) await settleDelivery("budget_exhausted", resultText);
			await notifyRoutineRunFailure({ origin: run.origin, agentRunId: runId, userId: runUserId, error: error.message }, routineRunFailureDeps(deps));
			await chainRunFollowUp(run, runUserId, deps);
			return { runId, status: "budget_exhausted" };
		}

		const kind = classifyRunError(error);
		if (kind === "lease_lost") {
			const state = await getRunLeaseState(runId);
			if (state?.cancelRequested) {
				return { runId, status: "cancelled" };
			}
			if (state?.leaseOwner && state.leaseOwner !== lease.owner) {
				return { runId, status: state.status };
			}
			const message =
				error instanceof Error ? error.message : "Lease perdido";
			await markAgentRunRetrying(runId, message, lease).catch((persistError) => {
				console.error(`retry state persistence failed run=${runId}`, persistError);
			});
			await releaseRunLease(runId, lease.owner, lease.token).catch(() => undefined);
			throw error instanceof Error ? error : new LeaseLostError();
		}
		if (kind === "transient") {
			const message =
				error instanceof Error ? error.message : "Falha transitória no worker";
			await coalescer.flush();
			await emitState.tail.catch(() => undefined);
			await markAgentRunRetrying(runId, message, lease).catch((persistError) => {
				console.error(`retry state persistence failed run=${runId}`, persistError);
			});
			await releaseRunLease(runId, lease.owner, lease.token).catch(() => undefined);
			throw error instanceof Error ? error : new LeaseLostError();
		}

		const message =
			error instanceof Error ? error.message : "Internal worker error";
		// Balão de erro amigável: erro cru do provedor (inglês/técnico) nunca
		// vai direto pra thread — traduz os conhecidos, mantém o resto para debug.
		// Runs proativos (lembrete/reflexão) falham sem usuário olhando: nada técnico
		// vai pro chat; o detalhe fica no log e em `error` do run.
		if (run.origin === "proactive") console.error(`proactive run failed run=${runId}`, error);
		const displayMessage = proactiveFailureDisplay(run.origin, describeRunError(error).message);
		await emit({ type: "error", error: displayMessage });
		await coalescer.flush();
		await emitState.tail;
		await finishAgentRun(runId, {
			status: kind === "waiting_user" ? "waiting_user" : "failed",
			error: message,
			resultText:
				kind === "waiting_user"
					? undefined
					: ((error instanceof AgentRunLoopDetectedError
							? error.finalText
							: undefined) ?? displayMessage),
			usage: error instanceof AgentRunLoopDetectedError ? error.usage : undefined,
			sandboxSessionId: cachedSessionId,
			lease,
		}).catch((finishError) => {
			if (
				finishError instanceof Error &&
				finishError.message === "lease_lost"
			) {
				throw new LeaseLostError();
			}
			throw finishError;
		});
		if (kind !== "waiting_user") {
			await settleDelivery("failed", displayMessage);
			await notifyRoutineRunFailure({ origin: run.origin, agentRunId: runId, userId: runUserId, error: message }, routineRunFailureDeps(deps));
			await chainRunFollowUp(run, runUserId, deps);
		}
		if (kind === "waiting_user") {
			return { runId, status: "waiting_user", error: message };
		}
		// Permanente: já finalizado acima, falha sem consumir novos attempts.
		throw new UnrecoverableError(message);
	}
}

/**
 * Retries da fila esgotados: fecha o run como um fim normal com falha. A mensagem amigável vai
 * ao chat (resultText), a entrega offline é liquidada e as mensagens pendentes do usuário viram
 * o próximo turno. O erro técnico continua em `error` do run e nos logs/Sentry. Nunca lança.
 */
export type ExhaustedRunIo = {
	getRun: (runId: string) => Promise<AgentRun | null>;
	failRun: (runId: string, error: string, display: { resultText: string }) => Promise<boolean>;
	settle: (input: { userId: string; runId: string; end: RunEnd; resultText: string }) => Promise<void>;
	chain: (run: AgentRun, userId: string, deps: AgentRunProcessorDeps) => Promise<void>;
	/** Retomada automática de falha transitória (padrão: banco e fila reais quando há `enqueueNextRun`). */
	autoContinue?: AutoContinueIo;
	/** Fala do assistente na conversa (aviso quando a retomada não saiu do papel). */
	appendAssistant: (conversationId: string, text: string) => Promise<unknown>;
	/** Push de rotina que falhou de vez (padrão: db + notifier reais). */
	notifyRoutineFailure?: (input: { origin: string | null | undefined; agentRunId: string; userId: string; error: string }) => Promise<unknown>;
};

const EXHAUSTED_IO: ExhaustedRunIo = {
	getRun: getAgentRun,
	failRun: failAgentRunAfterRetries,
	settle: (input) => settleRunDelivery(input, { markReady: markDeliveryReady, cancel: cancelRunDelivery }),
	chain: chainRunFollowUp,
	appendAssistant: (conversationId, text) => appendConversationMessage(conversationId, "assistant", text),
};

export async function finalizeExhaustedAgentRun(
	runId: string,
	err: Error,
	attempts: number,
	deps: AgentRunProcessorDeps = {},
	io: Partial<ExhaustedRunIo> = {},
): Promise<boolean> {
	const d = { ...EXHAUSTED_IO, ...io };
	try {
		const run = await d.getRun(runId);
		const friendly = describeRunError(err).message;
		const failureDisplay = proactiveFailureDisplay(run?.origin ?? "", friendly);
		const technical = `Falha após ${attempts} tentativa${attempts === 1 ? "" : "s"}: ${err.message}`;
		// Falha transitória do provedor/rede com progresso: uma retomada automática (limitada) antes de desistir.
		const autoIo = d.autoContinue ?? (deps.enqueueNextRun ? createAutoContinueIo(deps.enqueueNextRun) : undefined);
		const autoPlan: AutoContinueDecision = autoIo && run?.userId
			? await planAutoContinue(run, { cause: autoContinueCauseOfFailure(err) }, autoIo).catch((): AutoContinueDecision => ({ schedule: false, reason: "not_recoverable" }))
			: { schedule: false, reason: "not_recoverable" };
		const display = autoPlan.schedule ? AUTO_CONTINUE_STATUS_TEXT : failureDisplay;
		const finalized = await d.failRun(runId, technical, { resultText: display });
		if (!finalized || !run) return finalized;
		if (autoPlan.schedule && autoIo && run.userId) {
			const outcome = await scheduleAutoContinue(run, run.userId, autoPlan, autoIo);
			if (autoContinueScheduled(outcome)) {
				await d.settle({ userId: run.userId, runId, end: "cancelled", resultText: display }).catch((error) => console.error(`settleDelivery failed run=${runId}`, error));
				return true;
			}
			// A retomada não saiu do papel: o usuário recebe o erro de sempre em vez de ficar esperando.
			if (run.conversationId) await d.appendAssistant(run.conversationId, failureDisplay).catch(() => undefined);
		}
		if (run.userId) {
			await d.settle({ userId: run.userId, runId, end: "failed", resultText: failureDisplay }).catch((error) => console.error(`settleDelivery failed run=${runId}`, error));
			await (d.notifyRoutineFailure ?? ((input) => notifyRoutineRunFailure(input, routineRunFailureDeps(deps))))({ origin: run.origin, agentRunId: runId, userId: run.userId, error: technical });
			await d.chain(run, run.userId, deps);
		}
		return true;
	} catch (error) {
		console.error(`[agent] Could not finalize run ${runId} after retries:`, error);
		return false;
	}
}

export const AGENT_RUN_JOB_NAME = ATLAS_JOB_NAMES.runAgent;
