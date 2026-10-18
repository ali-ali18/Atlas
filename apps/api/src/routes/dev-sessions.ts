import { Hono } from "hono";
import {
	appendRunEvent,
	findDevSessionJob,
	getDevSession,
	getDevSessionStats,
	getOwnedConversation,
	getRunIdForDevEvents,
	listActiveMainRunIds,
	listActiveWorkForUser,
	listDevSessionHistory,
	listDevSessionsForConversation,
	requestCancelAgentRun,
	updateDevSession,
	type DevSessionRecord,
} from "@workspace/db";
import { publishRunSignal } from "@workspace/queue";
import {
	DevSandboxError,
	createDevClient,
	createDockerDevProvider,
	loadDevSandboxConfig,
	type DevClient,
	type DevEndpoint,
	type DevSandboxProvider,
} from "@workspace/sandbox";
import { fetchPullSnapshot, getGithubConnectionToken, type PullSnapshot } from "@workspace/agent-runtime";
import { capHistoryShellOutput, type DevSessionEvent } from "@workspace/shared";
import { notifyRunSignal, type PublishRunSignal } from "../run-signal.js";
import { scopeFor, type AuthEnv } from "../middleware/auth.js";
import { createDefaultDevJobDeps, reconcileSessionJobs, type DevJobDeps } from "../dev-jobs.js";

type Deps = {
	getOwnedConversation: typeof getOwnedConversation;
	listForConversation: typeof listDevSessionsForConversation;
	getSession: typeof getDevSession;
	getStats: typeof getDevSessionStats;
	listHistory: typeof listDevSessionHistory;
	listActiveWork: typeof listActiveWorkForUser;
	findJob: typeof findDevSessionJob;
	getEventRunId: typeof getRunIdForDevEvents;
	listActiveRunIds: typeof listActiveMainRunIds;
	appendEvent: (runId: string, event: DevSessionEvent) => Promise<unknown>;
	updateSession: typeof updateDevSession;
	/** Token do GitHub do usuário (nulo = só repositórios públicos). */
	getGithubToken: (userId: string) => Promise<string | null>;
	fetchSnapshot: (token: string | undefined, repo: string, number: number) => Promise<PullSnapshot | { error: { status: number; message: string } }>;
	cancelRun: (runId: string) => Promise<unknown>;
	/** Provedor Docker (null = sessões de desenvolvimento desligadas neste servidor). */
	provider: () => DevSandboxProvider | null;
	makeClient: (endpoint: DevEndpoint) => DevClient;
	/** Espera depois do kill antes de conferir o estado do job. */
	killSettleMs: number;
	/** Reconciliação de jobs em segundo plano sem `shell_done` (sessão parada, container recriado, agente parou de acompanhar). */
	jobs: (provider: () => DevSandboxProvider | null) => DevJobDeps;
};

let cachedProvider: DevSandboxProvider | null | undefined;
function defaultProvider(): DevSandboxProvider | null {
	if (cachedProvider === undefined) {
		const config = loadDevSandboxConfig();
		cachedProvider = config.enabled ? createDockerDevProvider(config) : null;
	}
	return cachedProvider;
}

const defaultDeps: Deps = {
	getOwnedConversation,
	listForConversation: listDevSessionsForConversation,
	getSession: getDevSession,
	getStats: getDevSessionStats,
	listHistory: listDevSessionHistory,
	listActiveWork: listActiveWorkForUser,
	findJob: findDevSessionJob,
	getEventRunId: getRunIdForDevEvents,
	listActiveRunIds: listActiveMainRunIds,
	appendEvent: (runId, event) => appendRunEvent(runId, event.type, event),
	updateSession: updateDevSession,
	getGithubToken: async (userId) => {
		const result = await getGithubConnectionToken(userId).catch(() => null);
		return result && "token" in result ? result.token : null;
	},
	fetchSnapshot: (token, repo, number) => fetchPullSnapshot(token, repo, number),
	cancelRun: async (runId) => {
		await requestCancelAgentRun(runId);
		await notifyRunSignal(publishRunSignal as PublishRunSignal, runId, "cancel");
	},
	provider: defaultProvider,
	makeClient: (endpoint) => createDevClient(endpoint),
	killSettleMs: 600,
	jobs: createDefaultDevJobDeps,
};

/** Última leitura do CI por sessão (memória do processo): evita eventos repetidos e limita as chamadas ao GitHub. */
const ciState = new Map<string, { at: number; signature: string; body: unknown }>();
const CI_MIN_INTERVAL_MS = 5_000;

/** Resumo para a lista (sem containerId nem lastError internos). */
export function toDevSessionSummary(row: DevSessionRecord) {
	return {
		id: row.id,
		conversationId: row.conversationId,
		status: row.status,
		tier: row.tier,
		repo: row.repo,
		branch: row.branch,
		baseBranch: row.baseBranch,
		pr: row.pr ?? null,
		startedAt: row.createdAt.toISOString(),
		lastActiveAt: row.lastActiveAt.toISOString(),
	};
}

/**
 * Sessões de desenvolvimento do agente (painel de detalhe). Mesmo escopo das
 * rotas de conversa: o dono vem da sessão de login; recurso alheio responde 404.
 */
export function createDevSessionRoutes(overrides: Partial<Deps> = {}) {
	const deps: Deps = { ...defaultDeps, ...overrides };
	const app = new Hono<AuthEnv>();

	/** Grava o evento no run mais recente da conversa (o SSE e o histórico o entregam). */
	async function emit(session: Pick<DevSessionRecord, "conversationId">, event: DevSessionEvent) {
		if (!session.conversationId) return;
		try {
			const runId = await deps.getEventRunId(session.conversationId);
			if (runId) await deps.appendEvent(runId, event);
		} catch (error) {
			console.warn("dev session event failed", error instanceof Error ? error.message : "unknown");
		}
	}

	const statusEvent = (session: DevSessionRecord, status: DevSessionRecord["status"]): DevSessionEvent => ({
		type: "dev_session_status",
		sessionId: session.id,
		status,
		tier: session.tier,
		...(session.repo ? { repo: session.repo } : {}),
		...(session.branch ? { branch: session.branch } : {}),
	});

	app.get("/v1/dev-sessions", async (c) => {
		try {
			const { userId } = scopeFor(c.get("session"));
			const conversationId = c.req.query("conversationId")?.trim();
			if (!conversationId) return c.json({ error: "conversationId is required" }, 400);
			if (!(await deps.getOwnedConversation(conversationId, userId))) return c.json({ error: "Conversation not found" }, 404);
			const rows = await deps.listForConversation(conversationId, userId);
			return c.json({ sessions: rows.map(toDevSessionSummary) });
		} catch (error) {
			console.error("list dev sessions failed", error);
			return c.json({ error: "Failed to list dev sessions" }, 503);
		}
	});

	/** Trabalho em andamento do usuário (sessões de código e subagentes) em todas as conversas. */
	app.get("/v1/dev-sessions/active", async (c) => {
		try {
			const { userId } = scopeFor(c.get("session"));
			return c.json({ items: await deps.listActiveWork(userId) });
		} catch (error) {
			console.error("list active work failed", error);
			return c.json({ error: "Failed to list active work" }, 503);
		}
	});

	app.get("/v1/dev-sessions/:id", async (c) => {
		try {
			const { userId } = scopeFor(c.get("session"));
			const row = await deps.getSession(c.req.param("id"), userId);
			if (!row) return c.json({ error: "Dev session not found" }, 404);
			const stats = await deps.getStats(row);
			return c.json({
				...toDevSessionSummary(row),
				todos: row.todos,
				stats,
			});
		} catch (error) {
			console.error("get dev session failed", error);
			return c.json({ error: "Failed to load dev session" }, 503);
		}
	});

	/**
	 * Histórico persistido: eventos de run da conversa que citam a sessão,
	 * cronológicos, com a saída de cada comando limitada ao fim (64KB).
	 * `after` = `createdAt` do último evento já aplicado (atualização incremental).
	 */
	app.get("/v1/dev-sessions/:id/events", async (c) => {
		try {
			const { userId } = scopeFor(c.get("session"));
			const row = await deps.getSession(c.req.param("id"), userId);
			if (!row) return c.json({ error: "Dev session not found" }, 404);
			const afterRaw = c.req.query("after");
			const after = afterRaw ? new Date(afterRaw) : undefined;
			if (after && Number.isNaN(after.getTime())) return c.json({ error: "Invalid after" }, 400);
			// Hidratação: comandos "em execução" cuja sessão parou ou cujo container não conhece o job viram "perdido".
			// Com run do agente ativo ele acompanha os próprios jobs: reconciliar aqui duplicaria shell_output/shell_done.
			const agentActive = row.conversationId ? (await deps.listActiveRunIds(row.conversationId).catch(() => [])).length > 0 : false;
			if (!agentActive && (!after || !["RUNNING", "IDLE"].includes(row.status))) {
				await reconcileSessionJobs(row, { ...deps.jobs(deps.provider), emit }).catch((error) =>
					console.warn("reconcile dev jobs failed", error instanceof Error ? error.message : "unknown"),
				);
			}
			const events = capHistoryShellOutput(await deps.listHistory(row, { after }));
			return c.json({ events, nextAfter: events.length ? events[events.length - 1]!.createdAt : (afterRaw ?? null) });
		} catch (error) {
			console.error("dev session history failed", error);
			return c.json({ error: "Failed to load history" }, 503);
		}
	});

	/**
	 * Atualiza o PR e os checks da sessão direto no GitHub (sem gastar tokens do agente) e
	 * grava os eventos `dev_pr`/`dev_ci` só quando algo mudou. O painel chama em intervalos
	 * crescentes enquanto há checks pendentes; sessão parada/expirada responde 409 (para o polling).
	 */
	app.post("/v1/dev-sessions/:id/ci/refresh", async (c) => {
		try {
			const { userId } = scopeFor(c.get("session"));
			const row = await deps.getSession(c.req.param("id"), userId);
			if (!row) return c.json({ error: "Dev session not found" }, 404);
			if (!row.pr || !row.repo) return c.json({ error: "A sessão não tem pull request" }, 409);
			if (row.status === "STOPPED" || row.status === "EXPIRED" || row.status === "ERROR") {
				ciState.delete(row.id);
				return c.json({ error: "A sessão não está ativa", stopped: true }, 409);
			}
			const previous = ciState.get(row.id);
			if (previous && Date.now() - previous.at < CI_MIN_INTERVAL_MS) return c.json(previous.body);
			const token = await deps.getGithubToken(userId);
			const result = await deps.fetchSnapshot(token ?? undefined, row.repo, row.pr.number);
			if ("error" in result) return c.json({ error: "Não consegui consultar o GitHub agora" }, 502);
			const body = { pr: result.pr, checks: result.checks, summary: result.summary };
			const signature = JSON.stringify([result.pr.state, result.pr.title, result.pr.headSha, result.checks.map((check) => [check.name, check.status, check.conclusion])]);
			if (previous?.signature !== signature) {
				const changedPr = row.pr.state !== result.pr.state || row.pr.headSha !== (result.pr.headSha ?? null) || row.pr.title !== result.pr.title;
				if (changedPr) {
					await deps.updateSession(row.id, { pr: { ...result.pr, headSha: result.pr.headSha ?? null } });
					await emit(row, { type: "dev_pr", sessionId: row.id, ...result.pr });
				}
				await emit(row, { type: "dev_ci", sessionId: row.id, checks: result.checks, summary: result.summary });
			}
			ciState.set(row.id, { at: Date.now(), signature, body });
			return c.json(body);
		} catch (error) {
			console.error("refresh dev ci failed", error instanceof Error ? error.message : "unknown");
			return c.json({ error: "Failed to refresh CI" }, 503);
		}
	});

	/** Encerra um comando em execução (SIGTERM; `force` = SIGKILL) e registra o fim no log. */
	app.post("/v1/dev-sessions/:id/jobs/:jobId/kill", async (c) => {
		try {
			const { userId } = scopeFor(c.get("session"));
			const row = await deps.getSession(c.req.param("id"), userId);
			if (!row) return c.json({ error: "Dev session not found" }, 404);
			const provider = deps.provider();
			if (!provider) return c.json({ error: "Dev sessions are disabled" }, 503);
			const jobId = c.req.param("jobId");
			const job = await deps.findJob(row, jobId);
			if (!job) return c.json({ error: "Job not found" }, 404);
			const endpoint = await provider.endpoint(row.id);
			// Job perdido (sessão parada ou container recriado): nada a matar; só limpa o card ("lost").
			// O container também avisa o fim por callback; quem chegar depois não emite de novo.
			const emitDoneOnce = async (event: DevSessionEvent) => {
				const stillOpen = await deps.jobs(deps.provider).listOpenJobs(row).then((open) => open.some((j) => j.jobId === jobId), () => true);
				if (stillOpen) await emit(row, event);
			};
			const markLost = async () => {
				await emitDoneOnce({ type: "shell_done", sessionId: row.id, callId: job.callId, jobId, exitCode: null, durationMs: job.startedAt ? Math.max(0, Date.now() - Date.parse(job.startedAt)) : 0, endedReason: "lost" });
				return c.json({ ok: true, running: false, lost: true });
			};
			if (!endpoint) return markLost();
			const body = (await c.req.json().catch(() => ({}))) as { force?: unknown };
			const client = deps.makeClient(endpoint);
			try {
				await client.execKill(jobId, body.force === true ? "SIGKILL" : "SIGTERM");
			} catch (error) {
				if (error instanceof DevSandboxError && error.status === 404) return markLost();
				throw error;
			}
			if (deps.killSettleMs > 0) await new Promise((resolve) => setTimeout(resolve, deps.killSettleMs));
			const snap = await client.execPoll(jobId, { waitMs: 0 }).catch(() => null);
			const done = !snap || !snap.running;
			if (done) {
				await emitDoneOnce({
					type: "shell_done",
					sessionId: row.id,
					callId: job.callId,
					jobId,
					exitCode: snap?.exitCode ?? null,
					durationMs: snap?.durationMs ?? 0,
					endedReason: "killed",
				});
			}
			return c.json({ ok: true, running: !done });
		} catch (error) {
			console.error("kill dev job failed", error);
			return c.json({ error: "Failed to kill job" }, 503);
		}
	});

	/**
	 * Para a sessão inteira: container parado (workspace preservado), status
	 * STOPPED. Por padrão também cancela o run em andamento da conversa, senão o
	 * agente religaria o container na próxima ferramenta (`keepRun=1` mantém o run).
	 */
	app.post("/v1/dev-sessions/:id/stop", async (c) => {
		try {
			const { userId } = scopeFor(c.get("session"));
			const row = await deps.getSession(c.req.param("id"), userId);
			if (!row) return c.json({ error: "Dev session not found" }, 404);
			const provider = deps.provider();
			if (!provider) return c.json({ error: "Dev sessions are disabled" }, 503);
			const cancelledRuns: string[] = [];
			if (c.req.query("keepRun") !== "1" && row.conversationId) {
				for (const runId of await deps.listActiveRunIds(row.conversationId)) {
					await deps.cancelRun(runId);
					cancelledRuns.push(runId);
				}
			}
			await provider.stop(row.id);
			await deps.updateSession(row.id, { status: "STOPPED", touch: true });
			await emit(row, statusEvent(row, "STOPPED"));
			await reconcileSessionJobs(row, { ...deps.jobs(deps.provider), emit }, { force: "stopped" }).catch(() => undefined);
			return c.json({ ok: true, status: "STOPPED", cancelledRuns });
		} catch (error) {
			console.error("stop dev session failed", error);
			return c.json({ error: "Failed to stop dev session" }, 503);
		}
	});

	/** Religa uma sessão parada (mesmo workspace). Sem vaga no servidor: 409. */
	app.post("/v1/dev-sessions/:id/resume", async (c) => {
		try {
			const { userId } = scopeFor(c.get("session"));
			const row = await deps.getSession(c.req.param("id"), userId);
			if (!row) return c.json({ error: "Dev session not found" }, 404);
			if (row.status === "EXPIRED") return c.json({ error: "A sessão expirou; peça ao agente para iniciar uma nova" }, 410);
			const provider = deps.provider();
			if (!provider) return c.json({ error: "Dev sessions are disabled" }, 503);
			const result = await provider.ensureRunning({ sessionId: row.id, userId: row.userId, tier: row.tier });
			if (result.status === "queued") {
				return c.json({ ok: false, status: row.status, error: result.denied.message }, 409);
			}
			await deps.updateSession(row.id, { status: "RUNNING", containerId: result.containerId, lastError: null, touch: true });
			await emit(row, statusEvent(row, "RUNNING"));
			return c.json({ ok: true, status: "RUNNING" });
		} catch (error) {
			console.error("resume dev session failed", error);
			return c.json({ error: "Failed to resume dev session" }, 503);
		}
	});

	return app;
}
