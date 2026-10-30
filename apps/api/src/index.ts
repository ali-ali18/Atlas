// Fase 0: dotenv ANTES de qualquer outro import — imports são hoisted e o
// @workspace/db valida ATLAS_HOOK_PEPPER no top-level (falha antes do
// loadEnv() se ele vier depois como chamada comum).
import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { accountChatgptGate, ensureGithubRepoHook } from "@workspace/agent-runtime";
import {
	closeRunSignals,
	closeSweepSignals,
	publishSweepSignal,
	publishRunSignal,
	publishRunEventsSignal,
	createAgentRunQueue,
	createChatCompletionQueue,
	createRedisConnection,
	createRoutineQueue,
} from "@workspace/queue";
import { loadConfig } from "./config.js";
import { registerEdgeMiddleware } from "./middleware/edge.js";
import { auth, authProviders, isOwnerEmail } from "./auth.js";
import { createViewerUpgradeHandler } from "./routes/sandbox-viewer.js";
import { createPreviewBasicRoutes, createPreviewOpenRoutes, createPreviewService, createUpgradeDispatcher, loadPreviewConfig, previewBootLog } from "./routes/previews.js";
import { createChatRoutes } from "./routes/chat.js";
import { createDevSessionRoutes } from "./routes/dev-sessions.js";
import { createDevEnvironmentRoutes } from "./routes/dev-environments.js";
import { createVaultRoutes } from "./routes/vault.js";
import { createBotRoutes } from "./routes/bots.js";
import { createGroupRoutes } from "./routes/groups.js";
import { createComputerUseRoutes } from "./routes/computer.js";
import { createConversationRoutes } from "./routes/conversations.js";
import { createReactionRoutes } from "./routes/reactions.js";
import { createPushRoutes } from "./routes/push.js";
import { createAvatarRoutes } from "./routes/avatars.js";
import { appendConversationMessage, conversationHoldsVm, logArtifactDir, createNotifier, createRedisCoalesce, createRedisPresence, getStrictOwnedConversation, installPushListener } from "@workspace/db";
import { isVmProtectedFromGuard, noticeVmStopped, type VmGuardDeps } from "./sandbox-guard-notice.js";
import { createWebPushSender } from "@workspace/mail";
import { ATLAS_JOB_NAMES, formatMissingEnv, readVapidConfig, redactPreviewPath, vapidProblems } from "@workspace/shared";
import { captureError, currentRequestId, initSentry, installRequestIdLogging } from "@workspace/observability";
import { requestIdMiddleware } from "./middleware/request-id.js";
import { createDiagnosticsRoutes } from "./routes/diagnostics.js";
import { createDefaultDiagnosticsDeps } from "./routes/diagnostics-deps.js";
import { createFileRoutes } from "./routes/files.js";
import { createPageRoutes } from "./routes/pages.js";
import { createPublicPageRoutes } from "./routes/public-pages.js";
import { createProfileRoutes } from "./routes/profile.js";
import { createMemoryRoutes } from "./routes/memory.js";
import { createLessonRoutes } from "./routes/lessons.js";
import { createComposioRoutes } from "./routes/composio.js";
import { createMcpRoutes } from "./routes/mcp.js";
import { createApiConnectionRoutes } from "./routes/api-connections.js";
import { createConnectorGuideRoutes } from "./routes/connector-guides.js";
import { setConnectorGuideEnqueuer } from "./connector-guide-queue.js";
import { setMemoryCleanupEnqueuer } from "./memory-cleanup-queue.js";
import { createProviderRoutes } from "./routes/providers.js";
import { createProviderKeyRoutes } from "./routes/provider-keys.js";
import { createModelRoutes } from "./routes/models.js";
import { createEventRoutes } from "./routes/events.js";
import { createHealthRoutes } from "./health.js";
import { endAllObserverStreams } from "./routes/run-observer.js";
import { closeUserEventWaker } from "./user-event-wakeups.js";
import { createRunRoutes, enqueueAgentRunJob, reconcileQueuedAgentRuns, resumeRunsAwaitingConnector } from "./routes/runs.js";
import { createEmailRoutes } from "./routes/email.js";
import { createEmailInboundRoutes } from "./webhooks/email-inbound.js";
import { notifyRunSignal } from "./run-signal.js";
import { createBotPendingRoutes } from "./routes/bot-pending.js";
import { applyQueuedBotDecisions } from "./chat/bot-pending-answer.js";
import { createRoutineRoutes } from "./routes/routines.js";
import { createGithubRoutes } from "./routes/github.js";
import { createGenericHookRoutes } from "./webhooks/generic.js";
import { createGithubHookRoutes } from "./webhooks/github.js";
import { createGithubAppRoutes } from "./routes/github-app.js";
import { createGithubAppWebhookRoutes } from "./webhooks/github-app.js";
import { createSandboxRoutes } from "./routes/sandbox.js";
import { createSectionRoutes } from "./routes/sections.js";
import { createAutonomyRoutes } from "./routes/autonomy.js";
import { createSettingsRoutes } from "./routes/settings.js";
import { createUsageRoutes } from "./routes/usage.js";
import { createSkillRoutes } from "./routes/skills.js";
import { createSkillDocRoutes } from "./routes/skill-docs.js";
import { createCatalogRoutes } from "./routes/catalog.js";
import { createSkillProposalRoutes } from "./routes/skill-proposals.js";
import { createBotProposalRoutes } from "./routes/bot-proposals.js";
import { createProactiveRoutes } from "./routes/proactive.js";
import { createReflectionRoutes } from "./routes/reflection.js";
import { createUploadRoutes } from "./routes/uploads.js";
import { createTranscriptionRoutes } from "./routes/transcriptions.js";
import {
	getDevSession,
	getDevSessionById,
	getOwnedConversation,
	listIdleDevSessions,
	listActiveMainRunIds,
	listQueuedDevSessions,
	listStoppedDevSessionsBefore,
	updateDevSession,
	prisma,
	setRunEventAppendedHook,
	setRunFinalizedByRequestHook,
	onGroupTurnCreated,
	onBotMessageCreated,
	listGithubRoutineRepoOwners,
	maybeClaimDefaultOnBoot,
} from "@workspace/db";
import {
	createDockerDevProvider,
	createSandboxManager,
	loadDevSandboxConfig,
	loadSandboxConfig,
	startDevSessionReaper,
	startDevEnvCacheSweep,
	startDevSessionQueue,
	startSandboxReaper,
} from "@workspace/sandbox";

import { createDefaultDevJobDeps, DEV_JOB_SWEEP_INTERVAL_MS, reconcileSessionJobs, startDevJobSweep } from "./dev-jobs.js";
import { createDevJobCallbackRoutes } from "./routes/dev-job-callback.js";

// Observabilidade: Sentry só com SENTRY_DSN; logs ganham o request-id; variáveis que faltam por recurso.
initSentry("api");
installRequestIdLogging();
for (const line of formatMissingEnv(process.env, "api")) console.warn(line);
logArtifactDir();

const baseConfig = loadConfig();
let chatQueue: ReturnType<typeof createChatCompletionQueue> | null = null;
let agentRunQueue: ReturnType<typeof createAgentRunQueue> | null = null;
let routineQueue: ReturnType<typeof createRoutineQueue> | null = null;
let redisConnection: ReturnType<typeof createRedisConnection> | null = null;

try {
	redisConnection = createRedisConnection(baseConfig.redisUrl);
	chatQueue = createChatCompletionQueue(redisConnection);
	agentRunQueue = createAgentRunQueue(redisConnection);
	routineQueue = createRoutineQueue(redisConnection);
	redisConnection.on("error", (err) => {
		console.error("Redis connection error", err);
	});
} catch (error) {
	console.error(
		"Redis/BullMQ queue not initialized; async chat/agent jobs disabled",
		error,
	);
}

const config = { ...baseConfig, chatQueue, agentRunQueue, routineQueue };
if (chatQueue) {
	const guideQueue = chatQueue;
	setConnectorGuideEnqueuer((payload, jobId) => guideQueue.add(ATLAS_JOB_NAMES.connectorGuide, payload, { jobId, attempts: 2 }));
	// Sem nova tentativa: falha vira estado visível na aba Memória.
	setMemoryCleanupEnqueuer((payload, jobId) => guideQueue.add(ATLAS_JOB_NAMES.memoryCleanup, payload, { jobId, attempts: 1 }));
}

const app = new Hono();

app.use("/*", requestIdMiddleware);
app.onError((error, c) => {
	// O `cap` da prévia (modo básico) é credencial: nunca vai a log nem a telemetria.
	const safePath = redactPreviewPath(c.req.path);
	console.error(`${c.req.method} ${safePath} failed`, error);
	captureError(error, { route: safePath, method: c.req.method, request_id: currentRequestId() });
	return c.text("Internal Server Error", 500);
});

const corsOrigins =
	process.env.CORS_ORIGIN?.split(",")
		.map((origin) => origin.trim())
		.filter(Boolean) ?? ["http://localhost:3000", "http://127.0.0.1:3000"];

// CORS, compressão, limites por IP, login e limite de corpo, nesta ordem (middleware/edge.ts; o teste usa a mesma função).
registerEdgeMiddleware(app, { corsOrigins });

// Acorda os streams SSE quando o run ganha evento (o worker faz o mesmo no processo dele).
setRunEventAppendedHook((runId) => void publishRunEventsSignal(runId));
// Turno de grupo / mensagem entre bots criados aqui: o worker varre na hora (o gancho do db é só deste processo).
onGroupTurnCreated(() => void publishSweepSignal("groups"));
onBotMessageCreated(() => void publishSweepSignal("bot-messages"));
// Run encerrado aqui (cancelar na fila ou parado num card): grupos e mensagens entre bots seguem sem esperar.
setRunFinalizedByRequestHook(() => {
	void publishSweepSignal("groups");
	void publishSweepSignal("bot-messages");
});

let apiShuttingDown = false;
app.route(
	"/",
	createHealthRoutes({
		checkDb: () => prisma.$queryRaw`SELECT 1`,
		checkRedis: redisConnection ? () => redisConnection!.ping() : undefined,
		isShuttingDown: () => apiShuttingDown,
	}),
);
app.get("/api/auth/providers", (c) => c.json(authProviders));
app.all("/api/auth/*", (c) => auth.handler(c.req.raw));

app.route("/", createChatRoutes(config));
app.route("/", createComputerUseRoutes(config));
app.route("/", createRunRoutes(config));
app.route("/", createEventRoutes());
app.route("/", createBotPendingRoutes(config));
app.route("/", createAvatarRoutes());
app.route("/", createBotRoutes());
app.route("/", createGroupRoutes());
app.route("/", createConversationRoutes());
app.route("/", createReactionRoutes());
// Notificador compartilhado com o guarda de memória das VMs (null sem VAPID/Redis).
let pushNotify: ReturnType<typeof createNotifier> | null = null;
{
	// Web Push: sem as chaves VAPID o app segue normal, só sem notificações no celular.
	const vapid = readVapidConfig(process.env);
	const sender = vapid ? createWebPushSender(vapid) : null;
	console.info(
		vapid
			? `[push] api: notificações push ligadas (redis ${redisConnection ? "ok" : "AUSENTE: sem presença nem avisos da API"})`
			: `[push] api: notificações push DESLIGADAS (${vapidProblems(process.env).join("; ")})`,
	);
	app.route("/", createPushRoutes({ vapid, sender, presence: redisConnection ? createRedisPresence(redisConnection) : null }));
	// A API também grava estados que viram aviso (sessão de código que falhou, cartão decidido no chat).
	if (sender && redisConnection) {
		pushNotify = createNotifier({ sender, presence: createRedisPresence(redisConnection), coalesce: createRedisCoalesce(redisConnection) });
		installPushListener(pushNotify);
	}
}
app.route("/", createDevSessionRoutes());
// Prévia privada: o link do chat passa por aqui (login do Atlas) antes de ir ao domínio separado da prévia.
const previewConfig = loadPreviewConfig();
const previewBoot = previewBootLog();
if (previewBoot) console[previewBoot.level](previewBoot.message);
const previewDevConfig = loadDevSandboxConfig();
const previewProvider = previewConfig && previewDevConfig.enabled && previewDevConfig.connectMode === "network" ? createDockerDevProvider(previewDevConfig) : null;
const previewDeps = {
	config: previewConfig,
	getSessionById: getDevSessionById,
	getOwnedSession: getDevSession,
	// Só no modo de rede compartilhada: com portas publicadas só o 3090 de controle é alcançável.
	resolveContainerHost: async (sessionId: string) => {
		const endpoint = previewProvider ? await previewProvider.endpoint(sessionId).catch(() => null) : null;
		return endpoint ? new URL(endpoint.baseUrl).hostname : null;
	},
	touch: (sessionId: string) => updateDevSession(sessionId, { touch: true }),
};
const previewService = createPreviewService(previewDeps);
app.route("/", createPreviewOpenRoutes(previewDeps));
app.route("/", createPreviewBasicRoutes(previewService));
app.route("/", createDevJobCallbackRoutes());
app.route("/", createDevEnvironmentRoutes());
app.route("/", createVaultRoutes());
app.route("/", createFileRoutes());
app.route("/", createPageRoutes());
app.route("/", createPublicPageRoutes());
app.route("/", createProfileRoutes());
app.route("/", createMemoryRoutes());
app.route("/", createLessonRoutes());
app.route("/", createMcpRoutes({
	onConnected: (userId, catalogId) => resumeRunsAwaitingConnector(agentRunQueue, userId, catalogId),
	onApiConnected: (userId, slug) => resumeRunsAwaitingConnector(agentRunQueue, userId, slug, "api"),
}));
app.route("/", createApiConnectionRoutes({ onConnected: (userId, slug) => resumeRunsAwaitingConnector(agentRunQueue, userId, slug, "api") }));
app.route("/", createConnectorGuideRoutes());
app.route("/", createComposioRoutes());
app.route("/", createModelRoutes());
app.route("/", createProviderRoutes(undefined, undefined, undefined, undefined, accountChatgptGate()));
app.route("/", createProviderKeyRoutes());
	app.route("/", createSandboxRoutes(loadSandboxConfig()));
	app.route("/", createSectionRoutes());
app.route("/", createSettingsRoutes());
app.route("/", createUsageRoutes());
app.route("/", createAutonomyRoutes());
app.route("/", createSkillRoutes());
app.route("/", createSkillDocRoutes());
app.route("/", createCatalogRoutes());
app.route("/", createSkillProposalRoutes());
app.route("/", createBotProposalRoutes());
app.route("/", createUploadRoutes({
	enqueueExtract: chatQueue
		? ({ userId, artifactId }) => chatQueue!.add(ATLAS_JOB_NAMES.attachmentExtract, { userId, artifactId }, { attempts: 1, removeOnComplete: 50, removeOnFail: 50 })
		: undefined,
}));
app.route("/", createTranscriptionRoutes());
app.route("/", createRoutineRoutes(routineQueue));
app.route("/", createProactiveRoutes(routineQueue));
app.route("/", createReflectionRoutes());
app.route("/", createDiagnosticsRoutes(createDefaultDiagnosticsDeps({ redis: redisConnection, queues: [chatQueue, agentRunQueue, routineQueue] })));
app.route("/", createGithubRoutes());
app.route("/", createGithubAppRoutes());
// Webhook do GitHub App: público (autentica pela assinatura HMAC), na allowlist do requireUser.
app.route("/", createGithubAppWebhookRoutes(routineQueue));
// GitHub antes do genérico: `/v1/hooks/:hookKey` também casa `/v1/hooks/github`
// e, registrado primeiro, respondia "Hook not found" a toda entrega do GitHub.
app.route("/", createGithubHookRoutes(routineQueue));
app.route("/", createGenericHookRoutes(routineQueue));
// E-mail do bot: configuração (sessão) e entrada pública (token + assinatura).
app.route("/", createEmailRoutes());
app.route(
	"/",
	createEmailInboundRoutes(() =>
		agentRunQueue
			? {
					enqueueRun: (runId) => enqueueAgentRunJob(agentRunQueue, runId),
					onMerged: (runId) => notifyRunSignal(publishRunSignal, runId, "input"),
					envDefaultModel: config.openRouterModel,
				}
			: null,
		{ routineQueue },
	),
);

const server = serve(
	{
		// Host `<id>.<ATLAS_PREVIEW_BASE_DOMAIN>` vai ao proxy da prévia (origem separada); o resto, às rotas do Atlas.
		fetch: async (request, env) => (await previewService.handleRequest(request)) ?? app.fetch(request, env),
		port: config.port,
		hostname: config.hostname,
	},
	(info) => {
		console.log(`Atlas API listening on http://localhost:${info.port}`);
	},
);

// Conexões keep-alive reaproveitadas pelo Next/Traefik: o padrão do Node (5 s)
// fecha o socket "no meio" de uma reutilização e vira 502/ECONNRESET intermitente.
{
	const http = server as import("node:http").Server;
	http.keepAliveTimeout = 65_000;
	http.headersTimeout = 66_000;
}

// WebSocket do noVNC (modo `SANDBOX_VIEWER_MODE=proxy`): o Hono não vê
// upgrades, então o proxy é ligado direto no http.Server.
{
	const sandboxConfig = loadSandboxConfig();
	const handleViewerUpgrade = createViewerUpgradeHandler({
		secret: process.env.BETTER_AUTH_SECRET ?? "",
		managerForUser: (userId) => createSandboxManager(sandboxConfig, userId),
		ownedConversation: getOwnedConversation,
		userFromRequest: async (headers) => {
			const session = await auth.api.getSession({ headers }).catch(() => null);
			return session && isOwnerEmail(session.user.email) ? session.user.id : null;
		},
	});
	const viewerProxy = sandboxConfig.enabled && sandboxConfig.viewerMode === "proxy";
	// Um só ouvinte: Host de prévia vai ao proxy da prévia (HMR); o resto segue o fluxo do viewer.
	if (viewerProxy || previewConfig) {
		(server as import("node:http").Server).on(
			"upgrade",
			createUpgradeDispatcher({ preview: previewService, ...(viewerProxy ? { viewer: handleViewerUpgrade } : {}) }),
		);
	}
}

/**
 * Claim-default no boot (F1): quando há exatamente 1 usuário e o e-mail dele
 * é o `ATLAS_OWNER_EMAIL`, reivindica as linhas legadas `"default"` pro dono.
 * Best-effort, não bloqueia o listen. Loga quantas linhas foram reivindicadas.
 */
void maybeClaimDefaultOnBoot()
	.then((result) => {
		if ("skipped" in result) {
			console.log(`[claim-default] ${result.skipped}`);
			return;
		}
		const total = Object.values(result.updated).reduce((sum, n) => sum + n, 0);
		console.log(
			`[claim-default] reivindicadas ${total} linhas para ${result.claimedFor}: ${JSON.stringify(result.updated)}`,
		);
	})
	.catch((error) => {
		console.error("[claim-default] falhou no boot (best-effort)", error);
	});

/**
 * Ressincroniza o webhook GitHub de toda rotina habilitada no boot —
 * best-effort, não bloqueia o listen. Cobre: `ATLAS_PUBLIC_URL` mudou desde
 * a última sincronização (hook aponta pra host antigo) e hooks legados
 * por-rotina de instalações anteriores (`ensureGithubRepoHook` reconhece e
 * migra em vez de duplicar — ver `isOurGithubHookUrl`). Nunca lança.
 */
void listGithubRoutineRepoOwners()
	.then(async (owners) => {
		if (owners.length === 0) return;
		let ok = 0;
		let failed = 0;
		for (const { userId, repo } of owners) {
			const result = await ensureGithubRepoHook({ userId, repo }).catch((error) => ({
				error: error instanceof Error ? error.message : String(error),
			}));
			if ("error" in result) {
				failed += 1;
				console.error(`[github-hook-resync] falhou userId=${userId} repo=${repo}: ${result.error}`);
			} else {
				ok += 1;
			}
		}
		console.log(`[github-hook-resync] concluído: ${ok} ok, ${failed} falhas (de ${owners.length})`);
	})
	.catch((error) => {
		console.error("[github-hook-resync] falhou ao listar rotinas GitHub", error);
	});

// Ciclo de vida das VMs de sandbox. A VM guarda o login do navegador, então NÃO é
// parada por inatividade (SANDBOX_IDLE_STOP=1 reativa o modo antigo, com SANDBOX_TTL_MS).
// Ela para quando o usuário manda, quando o bot termina (sandbox_release) ou pelo guarda
// de memória: acima de SANDBOX_MAX_RUNNING VMs (padrão 3) ou com pouca memória livre
// (SANDBOX_MIN_FREE_MEM_MB, padrão 512), para a VM ociosa há mais tempo e avisa o dono.
const sandboxTtlMs = Number.parseInt(
	process.env.SANDBOX_TTL_MS ?? "900000",
	10,
);
const vmGuardDeps: VmGuardDeps = {
	push: pushNotify ? (userId, conversationId, text) => pushNotify!(userId, conversationId, "run-finished", text) : null,
	ownsConversation: async (userId, conversationId) => Boolean(await getStrictOwnedConversation(conversationId, userId)),
	holdsVm: (userId, conversationId) => conversationHoldsVm(userId, conversationId),
	appendMessage: (conversationId, text) => appendConversationMessage(conversationId, "assistant", text),
};
startSandboxReaper(loadSandboxConfig(), {
	ttlMs: Number.isFinite(sandboxTtlMs) && sandboxTtlMs > 0 ? sandboxTtlMs : 900000,
	hardTtlMs: Number.POSITIVE_INFINITY,
	intervalMs: 60_000,
	idleStop: process.env.SANDBOX_IDLE_STOP === "1" || process.env.SANDBOX_IDLE_STOP === "true",
	memoryGuard: {
		// Depois de desligar: mensagem na conversa (garantida) + push (bônus).
		onStopped: (vm) => noticeVmStopped(vm, vmGuardDeps),
		// Não desliga VM sem dono verificável nem com run usando/esperando o usuário (a VM guarda a tela dele).
		isProtected: (vm) => isVmProtectedFromGuard(vm, vmGuardDeps),
	},
});

// Sessões de desenvolvimento (container leve por sessão): para as ociosas
// (DEV_SANDBOX_IDLE_MS) e expira as paradas há muito tempo. Só com DEV_SANDBOX_ENABLED.
const devSandboxConfig = loadDevSandboxConfig();
if (devSandboxConfig.enabled) {
	const devProvider = createDockerDevProvider(devSandboxConfig);
	const devJobDeps = createDefaultDevJobDeps(() => devProvider);
	// Caches de dependências dos ambientes: expira os sem uso (7 dias) e aplica o teto (DEV_SANDBOX_CACHE_MAX_GB), uma vez por dia.
	if (devSandboxConfig.cacheEnabled) startDevEnvCacheSweep(devProvider);
	startDevSessionReaper({
		provider: devProvider,
		idleMs: devSandboxConfig.idleMs,
		expireMs: devSandboxConfig.expireMs,
		intervalMs: 60_000,
		store: {
			listIdle: async (before) => (await listIdleDevSessions(before)).map((row) => ({ id: row.id, userId: row.userId, conversationId: row.conversationId })),
			listExpired: async (before) => (await listStoppedDevSessionsBefore(before)).map((row) => ({ id: row.id, userId: row.userId, conversationId: row.conversationId })),
			setStatus: (id, status, lastError) => updateDevSession(id, { status, ...(lastError ? { lastError } : {}) }),
			// Comando em segundo plano conta como atividade até o teto de 30 min; ao parar, fecha os jobs abertos no log.
			listOpenJobs: (session) => devJobDeps.listOpenJobs({ id: session.id, status: "RUNNING", conversationId: session.conversationId ?? null }),
			onEnded: async (session, reason) => {
				await reconcileSessionJobs({ id: session.id, status: "STOPPED", conversationId: session.conversationId ?? null }, devJobDeps, { force: reason });
			},
		},
	});
	// O fim de job chega por callback do container (rota interna); aqui só a varredura lenta de segurança.
	startDevJobSweep({
		...devJobDeps,
		listActiveSessions: async () => await listIdleDevSessions(new Date(Date.now() + 1_000), 200),
		hasActiveRun: async (session) => (session.conversationId ? (await listActiveMainRunIds(session.conversationId)).length > 0 : false),
		// Pergunta barata ao container (health.runningJobs) antes de qualquer consulta ao banco.
		probeRunning: async (session) => {
			const provider = devJobDeps.provider();
			const endpoint = provider ? await provider.endpoint(session.id).catch(() => null) : null;
			if (!endpoint) return null;
			const health = await devJobDeps.makeClient(endpoint).health().catch(() => null);
			return health ? health.runningJobs : null;
		},
		intervalMs: Number.parseInt(process.env.DEV_JOB_SWEEP_INTERVAL_MS ?? "", 10) > 0 ? Number.parseInt(process.env.DEV_JOB_SWEEP_INTERVAL_MS!, 10) : DEV_JOB_SWEEP_INTERVAL_MS,
	});
	// Sessões na fila (sem vaga quando o agente pediu): tenta de novo com espera crescente e marca RUNNING quando abre vaga.
	startDevSessionQueue({
		provider: createDockerDevProvider(devSandboxConfig),
		store: {
			listQueued: async () => (await listQueuedDevSessions()).map((row) => ({ id: row.id, userId: row.userId, tier: row.tier })),
			markRunning: (id, containerId) => updateDevSession(id, { status: "RUNNING", containerId, lastError: null, touch: true }),
		},
	});
}

// Runs presos (lease vencida, worker sem heartbeat, cancelamento órfão) e o reagendamento das rotinas
// ficam só no worker (index.ts dele, mesma cadência): rodar aqui também duplicava as consultas.
function runReconciliation() {
	void reconcileQueuedAgentRuns(agentRunQueue).catch((error) => {
		console.error("agent run reconciler failed", error);
	});
	// Decisões automáticas dos orquestradores ("Decidir pelos outros bots") esperando o card do destino.
	void applyQueuedBotDecisions({ queue: agentRunQueue, openRouterModel: config.openRouterModel }).catch((error) => {
		console.error("bot decisions sweeper failed", error);
	});
}

const reconcileTimer = setInterval(runReconciliation, 15_000);
runReconciliation();


/**
 * Ordem do encerramento (deploy/SIGTERM): sai da rotação (/health/ready 503), para de
 * aceitar conexões, fecha os SSE de forma limpa (o cliente reconecta com Last-Event-ID),
 * espera as requisições em curso por um tempo limitado e só então fecha filas, Redis e Prisma.
 */
async function shutdown() {
	if (apiShuttingDown) return;
	apiShuttingDown = true;
	console.log("Shutting down API...");
	// Rede de segurança: o compose dá 30s (stop_grace_period).
	setTimeout(() => {
		console.error("[shutdown] tempo esgotado; saindo à força");
		process.exit(1);
	}, 25_000).unref();
	const http = server as import("node:http").Server;
	const closed = new Promise<void>((resolve) => http.close(() => resolve()));
	http.closeIdleConnections?.();
	console.log(`[shutdown] ${endAllObserverStreams()} stream(s) SSE encerrados`);
	const forceTimer = setTimeout(() => http.closeAllConnections?.(), 8_000);
	forceTimer.unref();
	await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 10_000).unref())]);
	clearTimeout(forceTimer);
	http.closeAllConnections?.();
	if (chatQueue) {
		await chatQueue.close();
	}
	if (agentRunQueue) {
		await agentRunQueue.close();
	}
	if (routineQueue) {
		await routineQueue.close();
	}
	clearInterval(reconcileTimer);
	await closeRunSignals().catch(() => undefined);
	await closeSweepSignals().catch(() => undefined);
	await closeUserEventWaker().catch(() => undefined);
	if (redisConnection) {
		await redisConnection.quit();
	}
	await prisma.$disconnect();
	process.exit(0);
}

process.on("SIGINT", () => {
	void shutdown();
});
process.on("SIGTERM", () => {
	void shutdown();
});
