// Fase 0: dotenv ANTES de qualquer outro import — imports são hoisted e o
// @workspace/db valida ATLAS_HOOK_PEPPER no top-level (falha antes do
// loadEnv() se ele vier depois como chamada comum).
import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { accountChatgptGate, ensureGithubRepoHook } from "@workspace/agent-runtime";
import {
	closeRunSignals,
	publishRunSignal,
	publishRunEventsSignal,
	createAgentRunQueue,
	createChatCompletionQueue,
	createRedisConnection,
	createRoutineQueue,
	rehydrateRoutineSchedulers,
} from "@workspace/queue";
import { loadConfig } from "./config.js";
import { rateLimitByIp } from "./middleware/rate-limit.js";
import { requireUser } from "./middleware/auth.js";
import { jsonBodyLimit } from "./middleware/json-body-limit.js";
import { auth, authProviders, isOwnerEmail } from "./auth.js";
import { createViewerUpgradeHandler } from "./routes/sandbox-viewer.js";
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
import { createNotifier, createRedisCoalesce, createRedisPresence, installPushListener } from "@workspace/db";
import { createWebPushSender } from "@workspace/mail";
import { ATLAS_JOB_NAMES, formatMissingEnv, readVapidConfig, vapidProblems } from "@workspace/shared";
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
	getOwnedConversation,
	listIdleDevSessions,
	listActiveMainRunIds,
	listQueuedDevSessions,
	listStoppedDevSessionsBefore,
	updateDevSession,
	prisma,
	setRunEventAppendedHook,
	cancelStaleCancelledRuns,
	failStaleRunningRuns,
	listGithubRoutineRepoOwners,
	listSchedulableRoutines,
	maybeClaimDefaultOnBoot,
	recoverStaleRunningRuns,
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
	console.error(`${c.req.method} ${c.req.path} failed`, error);
	captureError(error, { route: c.req.path, method: c.req.method, request_id: currentRequestId() });
	return c.text("Internal Server Error", 500);
});

const corsOrigins =
	process.env.CORS_ORIGIN?.split(",")
		.map((origin) => origin.trim())
		.filter(Boolean) ?? ["http://localhost:3000", "http://127.0.0.1:3000"];

app.use(
	"/*",
	cors({
		origin: corsOrigins,
		allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
		allowHeaders: [
			"Content-Type",
			"Last-Event-ID",
			"Authorization",
			"X-Atlas-Hook-Secret",
			"X-Atlas-Idempotency-Key",
			"Idempotency-Key",
			"X-Request-Id",
		],
		exposeHeaders: ["X-Atlas-Run-Id", "X-Request-Id"],
	}),
);

app.use("/v1/hooks/*", rateLimitByIp(60, 60_000));
app.use("/v1/email/inbound/*", rateLimitByIp(120, 60_000));
app.use("/v1/runs/:id/stream", rateLimitByIp(30, 60_000));
app.use("/v1/chat/stream", rateLimitByIp(30, 60_000));
app.use("/v1/events", rateLimitByIp(60, 60_000));
app.use("/v1/internal/dev-jobs/*", rateLimitByIp(300, 60_000));
app.use("/v1/avatars/*", rateLimitByIp(120, 60_000));
app.use("/v1/public/*", rateLimitByIp(60, 60_000));
app.use("/v1/*", requireUser);
app.use("/v1/*", jsonBodyLimit);

// Acorda os streams SSE quando o run ganha evento (o worker faz o mesmo no processo dele).
setRunEventAppendedHook((runId) => void publishRunEventsSignal(runId));

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
		installPushListener(createNotifier({ sender, presence: createRedisPresence(redisConnection), coalesce: createRedisCoalesce(redisConnection) }));
	}
}
app.route("/", createDevSessionRoutes());
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
	),
);

const server = serve(
	{
		fetch: app.fetch,
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
	if (sandboxConfig.enabled && sandboxConfig.viewerMode === "proxy") {
		(server as import("node:http").Server).on("upgrade", (req, socket, head) => {
			void handleViewerUpgrade(req, socket, head);
		});
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

// GC das sessões de sandbox ociosas (TTL configurável).
// Política: a VM é do bot — TTL só ADORMECE (stop, preserva perfil/login).
// Remoção automática desligada (custo de parado ~zero e a sessão é sempre
// reutilizada); remover é ação administrativa manual.
const sandboxTtlMs = Number.parseInt(
	process.env.SANDBOX_TTL_MS ?? "900000",
	10,
);
startSandboxReaper(loadSandboxConfig(), {
	ttlMs: Number.isFinite(sandboxTtlMs) && sandboxTtlMs > 0 ? sandboxTtlMs : 900000,
	hardTtlMs: Number.POSITIVE_INFINITY,
	intervalMs: 60_000,
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

function runReconciliation() {
	void recoverStaleRunningRuns()
		.then((recovered) => {
			if (recovered.length > 0) {
				console.warn(
					`[agent] recovered stale running runs: ${recovered.length}`,
				);
			}
		})
		.catch((error) => {
			console.error("stale run recovery failed", error);
		})
		.finally(() => {
			void reconcileQueuedAgentRuns(agentRunQueue).catch((error) => {
				console.error("agent run reconciler failed", error);
			});
		});
	// Decisões automáticas dos orquestradores ("Decidir pelos outros bots") esperando o card do destino.
	void applyQueuedBotDecisions({ queue: agentRunQueue, openRouterModel: config.openRouterModel }).catch((error) => {
		console.error("bot decisions sweeper failed", error);
	});
	void failStaleRunningRuns()
		.then((failed) => {
			for (const runId of failed) {
				console.error(`[agent] Run ${runId} falhou: worker sem heartbeat`);
			}
		})
		.catch((error) => {
			console.error("stale run sweeper failed", error);
		});
	// Cancel órfão (worker morreu antes de observar): graça curta, o lease
	// saudável renova a cada 10s então 30s só pega órfão de verdade.
	void cancelStaleCancelledRuns(30_000)
		.then((cancelled) => {
			for (const runId of cancelled) {
				console.warn(`[agent] Run ${runId} cancelado (órfão reconciliado)`);
			}
		})
		.catch((error) => {
			console.error("stale cancel sweeper failed", error);
		});
}

const reconcileTimer = setInterval(runReconciliation, 15_000);
runReconciliation();

if (routineQueue) {
	const queue = routineQueue;
	void listSchedulableRoutines()
		.then((routines) => rehydrateRoutineSchedulers(queue, routines))
		.then(() => {
			console.log("Routine schedulers rehydrated from Postgres");
		})
		.catch((error) => {
			console.error("routine scheduler rehydrate failed", error);
		});
}

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
