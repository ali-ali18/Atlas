import { Hono } from "hono";
import { getDevSessionById, listActiveMainRunIds } from "@workspace/db";
import { loadDevSandboxConfig, createDockerDevProvider, verifyDevCallback, type DevSandboxProvider } from "@workspace/sandbox";
import { createDefaultDevJobDeps, reconcileSessionJobs, type DevJobDeps, type DevJobSession } from "../dev-jobs.js";

/**
 * `POST /v1/internal/dev-jobs/callback`: o container avisa que um job em segundo plano terminou.
 * Rota pública para o requireUser, autenticada pela assinatura HMAC do token DA SESSÃO (o mesmo
 * DEV_SANDBOX_TOKEN que a API já lê do container). O aviso não carrega saída: a API consulta o job,
 * pega o fim da saída/exit code e emite `shell_done` pelo caminho idempotente de sempre.
 *
 * Com um run do agente ativo na conversa, ele mesmo acompanha os jobs (evita duplicar): o aviso fica
 * pendente e a sessão é reconciliada UMA vez quando o run termina (cobre o job que acabou durante o run
 * depois que o agente parou de acompanhar). Pendências só vivem em memória: se a API reiniciar, a
 * varredura lenta de segurança fecha o que sobrar.
 */

export const CALLBACK_PATH = "/v1/internal/dev-jobs/callback";
const RATE_LIMIT = 60; // avisos por sessão por janela
const RATE_WINDOW_MS = 60_000;
const PENDING_MAX_AGE_MS = 2 * 60 * 60_000;
const DRAIN_INTERVAL_MS = 5_000;
const MAX_BODY = 4_096;

export type DevJobCallbackDeps = {
	getSession: (id: string) => Promise<(DevJobSession & { userId: string }) | null>;
	provider: () => DevSandboxProvider | null;
	hasActiveRun: (conversationId: string) => Promise<boolean>;
	jobs: DevJobDeps;
	now?: () => number;
	/** `false` desliga o relógio de pendências (teste chama `drainPending`). */
	autoDrain?: boolean;
};

export function createDevJobCallbackRoutes(overrides: Partial<DevJobCallbackDeps> = {}) {
	let cached: DevSandboxProvider | null | undefined;
	const provider =
		overrides.provider ??
		(() => {
			if (cached === undefined) {
				const config = loadDevSandboxConfig();
				cached = config.enabled ? createDockerDevProvider(config) : null;
			}
			return cached;
		});
	const deps: DevJobCallbackDeps = {
		getSession: (id) => getDevSessionById(id),
		hasActiveRun: async (conversationId) => (await listActiveMainRunIds(conversationId)).length > 0,
		jobs: overrides.jobs ?? createDefaultDevJobDeps(provider),
		...overrides,
		provider,
	};
	const now = () => deps.now?.() ?? Date.now();

	const buckets = new Map<string, { count: number; resetAt: number }>();
	function limited(sessionId: string): boolean {
		const t = now();
		let bucket = buckets.get(sessionId);
		if (!bucket || bucket.resetAt <= t) {
			if (buckets.size >= 5_000) for (const [key, b] of buckets) if (b.resetAt <= t) buckets.delete(key);
			if (buckets.size >= 5_000) return true;
			bucket = { count: 0, resetAt: t + RATE_WINDOW_MS };
			buckets.set(sessionId, bucket);
		}
		bucket.count += 1;
		return bucket.count > RATE_LIMIT;
	}

	const pending = new Map<string, number>(); // sessionId -> desde quando
	let timer: ReturnType<typeof setInterval> | undefined;

	async function reconcile(session: DevJobSession, only?: string) {
		await reconcileSessionJobs(session, deps.jobs, only ? { only } : {}).catch((error) => console.warn(`[dev-jobs] callback: ${error instanceof Error ? error.message : String(error)}`));
	}

	/** Reconcilia as sessões pendentes cujo run terminou (uma vez cada). */
	async function drainPending(): Promise<number> {
		let done = 0;
		for (const [sessionId, since] of [...pending]) {
			if (now() - since > PENDING_MAX_AGE_MS) {
				pending.delete(sessionId);
				continue;
			}
			const session = await deps.getSession(sessionId).catch(() => null);
			if (!session) {
				pending.delete(sessionId);
				continue;
			}
			if (session.conversationId && (await deps.hasActiveRun(session.conversationId).catch(() => true))) continue;
			pending.delete(sessionId);
			await reconcile(session);
			done += 1;
		}
		if (!pending.size && timer) {
			clearInterval(timer);
			timer = undefined;
		}
		return done;
	}

	function schedule(sessionId: string) {
		if (!pending.has(sessionId)) pending.set(sessionId, now());
		if (deps.autoDrain !== false && !timer) {
			timer = setInterval(() => void drainPending().catch(() => undefined), DRAIN_INTERVAL_MS);
			timer.unref?.();
		}
	}

	const app = new Hono();
	app.post(CALLBACK_PATH, async (c) => {
		const raw = await c.req.text();
		if (raw.length > MAX_BODY) return c.json({ error: "unauthorized" }, 401);
		let body: { sessionId?: unknown; jobId?: unknown } = {};
		try {
			body = JSON.parse(raw);
		} catch {
			return c.json({ error: "unauthorized" }, 401);
		}
		const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
		const jobId = typeof body.jobId === "string" && /^[a-f0-9]{12}$/.test(body.jobId) ? body.jobId : "";
		if (!sessionId || sessionId.length > 64) return c.json({ error: "unauthorized" }, 401);
		if (limited(sessionId)) return c.json({ error: "rate_limit_exceeded" }, 429);

		// Resposta uniforme (401) para sessão inexistente, container sem endpoint ou assinatura inválida.
		const session = await deps.getSession(sessionId).catch(() => null);
		const prov = deps.provider();
		const endpoint = session && prov ? await prov.endpoint(sessionId).catch(() => null) : null;
		const ok =
			!!session &&
			!!endpoint &&
			verifyDevCallback({
				token: endpoint.token,
				sessionId,
				timestamp: c.req.header("x-atlas-timestamp"),
				signature: c.req.header("x-atlas-signature"),
				body: raw,
				now: now(),
			});
		if (!session || !ok) return c.json({ error: "unauthorized" }, 401);
		if (!jobId) return c.json({ error: "invalid_job" }, 400);

		if (session.conversationId && (await deps.hasActiveRun(session.conversationId).catch(() => true))) {
			schedule(sessionId);
			return c.json({ ok: true, deferred: true }, 202);
		}
		await reconcile(session, jobId);
		return c.json({ ok: true }, 200);
	});

	return Object.assign(app, { drainPending, pendingCount: () => pending.size });
}
