import { createRunProviderServices } from "../provider-services.js";
import { createAssistantSegmentRecorder } from "../assistant-segments.js";
import { parseQuestionnaireAnsweredContent, isRecheckObjective, isRecheckToolAllowed, parseModelRef } from "@workspace/shared";
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
	type RoutineRecord,
	type SessionMessage,
	type UserSettings,
	formatCostLabel,
	isLlmChatRole,
	readDecideForOtherBots,
	readSubagentModel,
} from "@workspace/shared";
import {
	type Notify,
	prisma,
	appendAgentStep,
	appendConversationCard,
	appendRunAssistantSegment,
	appendRunEvent,
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
	listConversationArtifacts,
	listConversationResearchNotes,
	getConversationTaskContext,
	getConversationTaskLedger,
	listPendingQueueInputs,
	listStepsMissingCost,
	listPendingSteerInputs,
	listPendingInterruptInputIds,
	getGroupRunContext,
	listUserBotRoster,
	loadRecentConversationMessages,
	loadScreenshotArtifact,
	loadUserImageHistory,
	markAgentRunRetrying,
	persistRunProgress,
	persistScreenshotArtifact,
	readRunContextLength,
	releaseRunLease,
	releasePausedRunLease,
	renewRunLease,
	setRunSandboxSession,
	touchBotProfileCard,
	touchQuestionnaireCard,
	tryAcquireRunLease,
	type RunLease,
	getAccountConfig,
	persistConversationCardFromEvent,
} from "@workspace/db";
import {
	AgentRunCancelledError,
	AgentRunLoopDetectedError,
	AgentRunPausedError,
	BudgetExhaustedError,
	LeaseLostError,
	buildConversationArtifactsNote,
	classifyRunError,
	describeRunError,
	insertBeforeLastUser,
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
import { askJev, completeChat, evaluateMcpWithJev } from "@workspace/llm";
import type { WorkerConfig } from "../config.js";
import {
	HISTORY_LIMIT_ECONOMY,
	accountBudgetPolicy,
	appendObjective,
	historyWindowFor,
	resolveRunConfigSnapshot,
	runtimeParamsFromSnapshot,
	resolveMaintenanceModelForJob,
	resolveRunCodingModel,
	visionFallbackFromSnapshot,
	withConfigSnapshot,
} from "../run-config.js";
import { createRunEventCoalescer } from "../coalesce-run-events.js";
import { createRunControlReader } from "../run-control.js";
import { loadRunBase } from "../run-setup.js";
import { resolveRunAutonomy } from "../run-autonomy.js";
import { actionsJevMode, actionsJudgeModel, pendingJevMode, proactiveFailureDisplay, proactiveJevMode, resolveProactiveForRun } from "../proactive-run.js";
import { loadRunSkillIndex } from "../run-skills.js";
import { buildMentionNotes } from "../run-mentions.js";
import { getOpenRouterContextLength, isKnownOpenRouterModel, supportsImageInput } from "../openrouter-models.js";
import { imageVisionForRun } from "../image-vision.js";
import { attachmentRuntimeForRun } from "../attachments.js";
import { chainFollowUp, followUpRequest, laterFollowUpInput } from "../follow-up.js";
import { runPostCompletionSteps } from "../post-completion.js";
import { reconcileRunCosts } from "../cost-reconcile.js";
import { createAwayNoteHandler, settleRunDelivery, type RunEnd } from "../delivery/run-hooks.js";
import { acquireRunLeaseOrYield } from "../lease-owner.js";
import { startLeaseGuards, tickLeaseHeartbeat, type LeaseGuards } from "../lease-guards.js";

export { tickLeaseHeartbeat };

/** Atividade do run no hub: um aviso por run a cada 3 s (o texto vai pelo stream do run). */
const runActivityThrottle = createPublishThrottle(3_000);

/** Vale avisar o usuário do fim deste run? Sem conversa, sem texto ou de subagente, não. */
export function shouldPushRunEnd(run: { conversationId?: string | null; origin?: string | null }, text: string, hasNotify = true): boolean {
	return hasNotify && Boolean(run.conversationId) && text.trim().length > 0 && run.origin !== "subagent";
}

/** Origem automatizada (lembrete proativo, rotina, webhook) é "lembrete"; conversa normal é "terminou". */
export function pushKindForOrigin(origin: string | null | undefined): "reminder" | "run-finished" {
	return origin === "proactive" || origin === "routine" || origin === "webhook" ? "reminder" : "run-finished";
}

export type AgentRunProcessorDeps = {
	/** Notificação push (ausente = sem chaves VAPID). Ver `createNotifier` em @workspace/db. */
	notify?: Notify;
	enqueueMemoryReview?: (payload: MemoryReviewJobPayload) => Promise<void>;
	enqueueNextRun?: (runId: string) => Promise<boolean>;
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

async function prepareMessages(
	messages: ChatMessage[],
	botId?: string | null,
	conversationId?: string | null,
	userId?: string,
	compact?: boolean,
	group?: MemoryContextOptions["group"],
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
		return await executeLeasedRun({ run, runUserId, config, deps, lease, guards, apiKey: config.openRouterApiKey ?? "" });
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
	const groupRun = run.origin === "chat"
		? await getGroupRunContext({ userId: runUserId, botId: run.botId, conversationId: run.conversationId }).catch(() => null)
		: null;
	const groupPrompt = groupRun && run.botId ? { name: groupRun.groupName, selfId: run.botId, members: groupRun.members } : undefined;
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
	// E-mail próprio do bot (tools adiadas). No run de e-mail o envio segue a política real do dono, o resto é limitado.
	const emailContext = await loadEmailRunContext({
		userId: runUserId,
		botId: run.botId,
		sendPolicy: run.origin === "email"
			? await resolveRunAutonomy({ userId: runUserId, botId: run.botId, conversationId: run.conversationId, origin: run.origin, now: new Date(), uncapped: true })
			: autonomy,
	}).catch((error) => {
		console.error(`load email context failed run=${runId}`, error);
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
		});
		const runtimeConfig = runtimeParamsFromSnapshot(configSnapshot);
	 const providers = createRunProviderServices({ userId: runUserId, conversationId: run.conversationId, policy: rawBotPolicy, chatgptEnabled: configSnapshot.chatgptEnabled, openRouterKey: Boolean(config.openRouterApiKey), accountDefaultModel: async () => (await getAccountConfig(runUserId).catch(() => null))?.models?.default ?? null, onFallback: async notice => {
			await emit(notice);
			// Marcador persistido na conversa: sobrevive ao fim do run e a recarregar a thread.
			await persistConversationCardFromEvent(run.conversationId, notice, { runStartedAt: new Date(run.createdAt) }).catch((error) => console.error(`persist provider fallback card failed run=${runId}`, error));
		} });

		const canSeeUserImages = await providers.supportsImageInput(run.model);
		const openrouterVisionFallback = visionFallbackFromSnapshot(configSnapshot);
		const fallbackModel = openrouterVisionFallback && await supportsImageInput(openrouterVisionFallback)
			? openrouterVisionFallback
			: undefined;
		const imageVision = imageVisionForRun({ userId: runUserId, apiKey, fallbackModel });
		return { configSnapshot, runtimeConfig, providers, canSeeUserImages, imageVision };
	};
	const messagesStage = async () => {
		// Fase 2 — ciclo limpo: modo congelado no checkpoint; em run fresco,
		// liga sozinho com resumo fresco (sem resumo não há ciclo). Rotina fora.
		// Memória da conversa da conta (Padrão quando ausente). Retomada mantém o modo já congelado no checkpoint.
		const contextMemory = checkpoint?.llmMessages?.length
			? undefined
			: (await getAccountConfig(runUserId).catch(() => null))?.execution?.contextMemory;
		let compact = groupRun ? false : (checkpoint?.compact ?? false);
		let historyLimit = HISTORY_LIMIT_ECONOMY;
		if (
			!compact &&
			!groupRun &&
			!checkpoint?.llmMessages?.length &&
			run.conversationId &&
			run.origin !== "routine"
		) {
			const hasFreshSummary = contextMemory === "economy"
				? (await getFreshSummary(run.conversationId).catch(() => null)) !== null
				: false;
			({ compact, limit: historyLimit } = historyWindowFor(contextMemory, hasFreshSummary));
		}
		let inputMessages = checkpoint?.messages ?? [];
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
			} else if (run.conversationId) {
				const recent = await loadRecentConversationMessages(
					run.conversationId,
					compact ? COMPACT_TAIL_KEEP : historyLimit,
				);
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

		let messages = checkpoint?.llmMessages?.length
			? inputMessages
			: await prepareMessages(
					inputMessages,
					run.botId,
					run.conversationId,
					runUserId,
					compact,
					groupPrompt,
				);

		// Injetar nota sobre artefatos de runs anteriores (A2 step 3): apenas para run novo
		// na mesma conversa que tem histórico de artefatos.
		if (!checkpoint?.llmMessages?.length && run.conversationId && run.origin !== "routine") {
			try {
				const artifacts = await listConversationArtifacts(runUserId, run.conversationId, { limit: 5, excludeRunId: runId });
				const artifactsNote = buildConversationArtifactsNote(artifacts);
				if (artifactsNote) {
					messages = insertBeforeLastUser(messages, artifactsNote);
				}
			} catch (error) {
				console.error(`load conversation artifacts failed run=${runId}`, error);
				// Não falha o run; apenas segue sem a nota.
			}
		}

		// Tarefa ativa (bug #80): as últimas tarefas do usuário e os recursos que criaram, do banco.
		// Sobrevive à compactação do histórico; rotina/webhook ficam de fora (nunca viram "a tarefa").
		if (!checkpoint?.llmMessages?.length && run.conversationId && run.origin === "chat" && !groupRun) {
			try {
				const taskNote = buildConversationTaskNote(
					await getConversationTaskContext(runUserId, run.conversationId, { excludeRunId: runId }),
				);
				if (taskNote) messages = insertBeforeLastUser(messages, { role: "system", content: taskNote });
			} catch (error) {
				console.error(`load conversation task context failed run=${runId}`, error);
			}
		}

		// `/skill` e `@Bot` digitados pelo usuário neste turno (só chat 1:1, run novo): a skill já vem
		// carregada e os bots citados chegam com id. Falha não derruba o run.
		let forcedConnectors: string[] = [];
		if (!checkpoint?.llmMessages?.length && run.origin === "chat" && !groupRun && run.botId) {
			try {
				const turn = await buildMentionNotes({ userId: runUserId, botId: run.botId, text: run.objective, toolset: mcp?.toolset });
				for (const note of turn.notes) messages = insertBeforeLastUser(messages, { role: "system", content: note });
				forcedConnectors = turn.connectors;
			} catch (error) {
				console.error(`load composer mentions failed run=${runId}`, error);
			}
		}

		// Imagens de turnos anteriores vêm do que está persistido (dono validado no db),
		// nunca de ids enviados pelo cliente. Falha aqui não derruba o run.
		const historyImages = !checkpoint?.llmMessages?.length && run.conversationId && run.origin !== "routine"
			? await loadUserImageHistory(run.conversationId, runUserId).catch((error) => {
				console.error(`load image history failed run=${runId}`, error);
				return [];
			})
			: [];

		// Arquivos anexados (PDF, Office, planilha, texto, zip...): conteúdo do pedido atual e lista da conversa.
		const attachmentsForRun = run.origin !== "routine"
			? await attachmentRuntimeForRun({
				userId: runUserId,
				conversationId: run.conversationId,
				currentIds: checkpoint?.userFileArtifactIds ?? [],
				fresh: !checkpoint?.llmMessages?.length,
				model: run.model,
			}).catch((error) => {
				console.error(`load attachments failed run=${runId}`, error);
				return null;
			})
			: null;
		if (attachmentsForRun?.historyNote) messages = insertBeforeLastUser(messages, { role: "system", content: attachmentsForRun.historyNote });

		// Índice das skills do dono (K1): só em run novo; na retomada o prompt vem do checkpoint.
		const skillIndex = checkpoint?.llmMessages?.length
			? ""
			: await loadRunSkillIndex({ userId: runUserId, botId: run.botId });

		// Notas de pesquisa (F3) de runs anteriores da conversa: escopadas pelo dono da sessão; falha não derruba o run.
		const priorResearchNotes = !groupRun && run.conversationId && (run.origin === "chat" || run.origin === "webhook")
			? await listConversationResearchNotes(runUserId, run.conversationId, { excludeRunId: runId, origin: run.origin }).catch((error) => {
				console.error(`load research notes failed run=${runId}`, error);
				return [];
			})
			: [];

		// Ledger de itens (V3) de um run anterior da conversa: mesmo escopo de dono; falha não derruba o run.
		const priorTaskLedger = !groupRun && run.conversationId && (run.origin === "chat" || run.origin === "webhook")
			? await getConversationTaskLedger(runUserId, run.conversationId, { excludeRunId: runId, origin: run.origin }).catch((error) => {
				console.error(`load task ledger failed run=${runId}`, error);
				return null;
			})
			: null;

		return { messages, inputMessages, historyImages, skillIndex, forcedConnectors, priorResearchNotes, priorTaskLedger, attachments: attachmentsForRun?.runtime };
	};
	const [{ configSnapshot, runtimeConfig, providers, canSeeUserImages, imageVision }, { messages, inputMessages, historyImages, skillIndex, forcedConnectors, priorResearchNotes, priorTaskLedger, attachments }] =
		await Promise.all([configStage(), messagesStage()]);

	let cachedSessionId: string | null =
		checkpoint?.sandboxSessionId ?? run.sandboxSessionId;
	// Última sessão anunciada ao painel neste run: o reaproveitamento de uma sessão
	// herdada (checkpoint/run) também emite `session`, para o viewer seguir a VM certa.
	let announcedSessionId: string | null = null;

	// Orçamento: request (budgetJson) > bot (policyJson) > conta > padrões.

	const botPolicy = parseBudgetPolicy(rawBotPolicy);
	// Modo proativo: só o bot principal com o modo ligado (nunca em grupo).
	const proactiveBot = run.botId && (run.origin === "chat" || run.origin === "proactive") && !groupRun
		? await prisma.bot.findFirst({ where: { id: run.botId, ownerId: runUserId }, select: { isPrimary: true } }).catch(() => null)
		: null;
	const accountTimezone = proactiveBot?.isPrimary === true
		? (await getAccountConfig(runUserId).catch(() => null))?.general?.timezone
		: undefined;
	const proactiveForRun = resolveProactiveForRun({
		accountTimezone,
		origin: run.origin,
		isGroupRun: Boolean(groupRun),
		isPrimary: proactiveBot?.isPrimary === true,
		policyJson: rawBotPolicy,
	});
	const requestBudget = parseBudgetPolicy(run.budgetJson ?? null);
	const budget = resolveBudget({
		maxSteps: run.maxSteps,
		policy: { ...accountBudgetPolicy(configSnapshot, run.maxSteps), ...botPolicy, ...requestBudget },
	});
	const runStartedAt = run.startedAt
		? new Date(run.startedAt).getTime()
		: Date.now();
	if (cachedSessionId) {
		// Mesmo prazo do runtime: só tempo ativo (pausa e fila não contam).
		const { deadlineAtMs } = wallClockAnchors({ maxWallMs: budget.maxWallMs, now: Date.now(), runStartedAt, restored: checkpoint });
		const initialContext = { signal: aborter.signal, deadlineAtMs };
		cachedSessionId = await getRunningSessionId(manager.withExecutionContext?.(initialContext) ?? manager, cachedSessionId);
		aborter.signal.throwIfAborted();
	}

	const persistCheckpoint = async (next: AgentRunCheckpoint) => {
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
			})
		: null;
	const emitWithSegments = async (event: ComputerUseEvent) => {
		await segmentRecorder?.observe(event);
		return emit(event);
	};

	// Cancelamento e pausa dividem uma leitura (L10).
	const control = createRunControlReader({ read: () => getRunControlState(runId) });

	let completionPersisted: "completed" | "budget_exhausted" | null = null;
	// Triagem de mensagens do usuário durante o run: modelo barato de manutenção; falha = modelo do run.
	const messageTriageModel = await resolveMaintenanceModelForJob({
		kind: "summary",
		config,
		userId: runUserId,
		conversationId: run.conversationId ?? undefined,
	}).catch(() => undefined);
	// Entrega offline: com nota de ausência, o fim do run coloca o resultado no backlog.
	const settleDelivery = (end: RunEnd, resultText?: string | null) =>
		settleRunDelivery(
			{ userId: runUserId, runId, end, resultText },
			{ markReady: markDeliveryReady, cancel: cancelRunDelivery },
		);
	// APIs conectadas por OpenAPI (leitura). Falha ao carregar nunca derruba o run: segue sem elas.
	const apiConnector = await loadApiConnectorRuntime(runUserId).catch((error) => {
		console.error(`load api connections failed run=${runId}`, error);
		return null;
	});
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
			email: emailContext,
			// `@App` do usuário neste turno: as tools desses conectores já entram no 1º passo.
			forcedConnectors: forcedConnectors.length > 0 ? forcedConnectors : undefined,
			// Verificação de pendências da reflexão: só leitura (nativa ou conector que se declara somente leitura).
			toolFilter: isRecheckObjective(run.origin, run.objective)
				? (toolName: string) => isRecheckToolAllowed(toolName, mcp?.toolset.entries.get(toolName)?.readOnly)
				: undefined,
			autonomy,
			skillIndex,
			proactive: proactiveForRun,
			jevMcpMode: runtimeConfig.jevMcpMode,
			executionDiscipline: runtimeConfig.executionDiscipline,
			contextEconomy: runtimeConfig.contextEconomy,
			contextMemory: runtimeConfig.contextMemory,
			maxOutputTokens: runtimeConfig.maxOutputTokens,
			modelCallTimeoutMs: runtimeConfig.modelCallTimeoutMs,
			firstEventTimeoutMs: runtimeConfig.firstEventTimeoutMs,
			idleTimeoutMs: runtimeConfig.idleTimeoutMs,
			fallbackModels: runtimeConfig.fallbackModels,
			imageModel: runtimeConfig.imageModel,
			evaluateMcpWithJev: (state, signal) => evaluateMcpWithJev({ apiKey: config.openRouterApiKey!, state, signal }),
			jev: config.openRouterApiKey
				? {
						modes: { ...runtimeConfig.jevModes, proactive: proactiveJevMode(runtimeConfig.jevModes?.intent), pending: pendingJevMode(runtimeConfig.jevModes?.intent), actions: actionsJevMode() },
						// F0: duração/modelo/tokens por decisão, fora do uso principal.
						onDecision: (record) => jevTelemetry.record(record),
						// Verificador de ações: o modelo rápido devolve JSON (veredito + motivo) em texto.
						complete: async (request) =>
							(await completeChat({
								apiKey: config.openRouterApiKey!,
								model: actionsJudgeModel(),
								messages: [{ role: "system", content: request.system }, { role: "user", content: request.user }],
								timeoutMs: request.timeoutMs,
								signal: request.signal,
							})).message.content,
						ask: (request) => askJev({ apiKey: config.openRouterApiKey!, state: request.state, questions: request.questions, timeoutMs: request.timeoutMs, signal: request.signal }),
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
			objective: run.objective,
			maxSteps: run.maxSteps,
			// Janela gravada na criação (API); desconhecida = fallback 128k.
			contextLength: parseModelRef(run.model).provider !== "openrouter" ? (await providers.contextLength(run.model)) ?? 64000 : readRunContextLength(run),
			budget: {
				softMaxSteps: budget.softMaxSteps,
				hardMaxSteps: budget.hardMaxSteps,
				maxWallMs: budget.maxWallMs,
				maxTokens: budget.maxTokens,
				maxCallsPerTool: budget.maxCallsPerTool,
				extensionSteps: budget.extensionSteps,
			},
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
			priorResearchNotes,
			priorTaskLedger,
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
		await completeAgentRunAtomically({
			runId,
			conversationId: run.conversationId,
			assistantText: result.text,
			sandboxSessionId: cachedSessionId,
			lease,
			status: result.hitWall ? "budget_exhausted" : "completed",
			// Telemetria só no usageJson persistido; o evento `done` (UI) não a leva.
			usage: withRunTelemetry(result.usage, runTelemetry.meta(jevTelemetry.snapshot())),
			donePayload: {
				type: "done",
				message: { role: "assistant", content: result.text },
				model: result.model,
				usage: result.usage,
			},
		});
		// Daqui em diante a conclusão é irrevogável (ver catch).
		completionPersisted = result.hitWall ? "budget_exhausted" : "completed";

		// Ordem na thread: o card do questionário foi gravado durante o run e
		// a saudação/confirmação só na conclusão — sem o toque, o card fica
		// acima da saudação (invertido). Best effort, nunca quebra o run.
		// O questionnaireId é determinístico por run (ver runtime).
		if (run.conversationId && result.text.trim().length > 0) {
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
		await runPostCompletionSteps(runId, [
			{
				name: "memory-review",
				run:
					// Grupo: a conversa dele só vira memória do bot se o próprio bot salvar (tool memory) no run.
					deps.enqueueMemoryReview && run.conversationId && !groupRun && !onboardingRun
						? () =>
								deps.enqueueMemoryReview!({
									userId: runUserId,
									botId: run.botId ?? undefined,
									conversationId: run.conversationId!,
									messages: [
										...inputMessages,
										{ role: "assistant", content: result.text },
									],
								})
						: undefined,
			},
			{
				// Custo que o OpenRouter não informou: consulta depois pelo id da geração.
				// Fora do caminho do run (não espera) e sem nunca falhar.
				name: "cost-reconcile",
				run: async () => {
					void reconcileRunCosts(
						{ runId, userId: runUserId, apiKey },
						{ listMissing: listStepsMissingCost, apply: applyReconciledStepCost },
					).catch(() => undefined);
				},
			},
			{ name: "follow-up", run: () => chainRunFollowUp(run, runUserId, deps) },
			{ name: "delivery", run: () => settleDelivery(result.hitWall ? "budget_exhausted" : "completed", result.text) },
			{
				// Push: terminou (ou lembrete/rotina). O notify cuida de switch do bot, "está olhando", protocolo e coalescência.
				name: "push",
				run: shouldPushRunEnd(run, result.text, Boolean(deps.notify)) ? () => deps.notify!(runUserId, run.conversationId!, pushKindForOrigin(run.origin), result.text) : undefined,
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
			await emit({ type: "error", error: error.message });
			await coalescer.flush();
			await emitState.tail;
			await finishAgentRun(runId, {
				status: "budget_exhausted",
				error: error.message,
				// Resumo final do modelo (chamada sem tools), se houve; senão o erro.
				resultText: error.finalText ?? error.message,
				usage: error.usage,
				sandboxSessionId: cachedSessionId,
				lease,
			}).catch((finishError) => asLeaseError(finishError));
			await settleDelivery("budget_exhausted", error.finalText ?? error.message);
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
};

const EXHAUSTED_IO: ExhaustedRunIo = {
	getRun: getAgentRun,
	failRun: failAgentRunAfterRetries,
	settle: (input) => settleRunDelivery(input, { markReady: markDeliveryReady, cancel: cancelRunDelivery }),
	chain: chainRunFollowUp,
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
		const display = proactiveFailureDisplay(run?.origin ?? "", friendly);
		const technical = `Falha após ${attempts} tentativa${attempts === 1 ? "" : "s"}: ${err.message}`;
		const finalized = await d.failRun(runId, technical, { resultText: display });
		if (!finalized || !run) return finalized;
		if (run.userId) {
			await d.settle({ userId: run.userId, runId, end: "failed", resultText: display }).catch((error) => console.error(`settleDelivery failed run=${runId}`, error));
			await d.chain(run, run.userId, deps);
		}
		return true;
	} catch (error) {
		console.error(`[agent] Could not finalize run ${runId} after retries:`, error);
		return false;
	}
}

export const AGENT_RUN_JOB_NAME = ATLAS_JOB_NAMES.runAgent;
