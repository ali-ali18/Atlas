import { appendRunEvent, createPublishThrottle, getRunIdForDevEvents, listDevJobIdsWithOutput, listDevSessionJobEvents, prisma, publishUserEvent } from "@workspace/db";
import { createDevClient, DevSandboxError, type DevClient, type DevEndpoint, type DevSandboxProvider } from "@workspace/sandbox";
import { computeOpenDevJobs, DEV_JOB_MAX_MS, type DevSessionEvent, type DevShellEndedReason, type OpenDevJob } from "@workspace/shared";

/**
 * Reconciliação dos comandos em segundo plano de uma sessão de código. Um job só some do painel
 * ("Em execução") quando há um `shell_done` final; se o agente parou de acompanhar, o container foi
 * parado/recriado ou a sessão acabou, ninguém o emitia. Aqui a API fecha esses casos.
 */

/** Avisos de job no hub: no máximo um por sessão e tipo a cada 2 s. */
const devJobEventThrottle = createPublishThrottle(2_000);

export type DevJobSession = {
	id: string;
	status: string;
	conversationId: string | null;
};

export type DevJobDeps = {
	/** Jobs sem `shell_done` final (derivado dos eventos persistidos). */
	listOpenJobs: (session: DevJobSession) => Promise<OpenDevJob[]>;
	/** Grava o evento no run mais recente da conversa. */
	emit: (session: DevJobSession, event: DevSessionEvent) => Promise<void>;
	provider: () => DevSandboxProvider | null;
	makeClient: (endpoint: DevEndpoint) => DevClient;
	now?: () => number;
	jobCapMs?: number;
};

const ACTIVE = new Set(["RUNNING", "IDLE"]);
const TAIL_BYTES = 4_000;

function tailOf(text: string): string {
	return text.length > TAIL_BYTES ? `[... início omitido ...]\n${text.slice(-TAIL_BYTES)}` : text;
}

export type ReconcileResult = { closed: number; stillRunning: number };

/**
 * Fecha o que der dos jobs abertos da sessão. `force` = a sessão acabou de ser parada/expirada (todos
 * os jobs abertos terminam com esse motivo, sem consultar o container).
 */
export async function reconcileSessionJobs(session: DevJobSession, deps: DevJobDeps, options: { force?: "stopped" | "timeout" | "lost"; /** Só este job (callback do container). */ only?: string } = {}): Promise<ReconcileResult> {
	const now = deps.now?.() ?? Date.now();
	const jobCap = deps.jobCapMs ?? DEV_JOB_MAX_MS;
	const open = (await deps.listOpenJobs(session)).filter((job) => !options.only || job.jobId === options.only);
	const result: ReconcileResult = { closed: 0, stillRunning: 0 };
	if (!open.length) return result;

	const done = async (job: OpenDevJob, reason: DevShellEndedReason, exitCode: number | null, durationMs: number) => {
		// Idempotente: o agente (ou outra passada) pode ter fechado o job desde a leitura inicial.
		if (!(await deps.listOpenJobs(session)).some((j) => j.callId === job.callId)) return;
		await deps.emit(session, { type: "shell_done", sessionId: session.id, callId: job.callId, jobId: job.jobId, exitCode, durationMs, endedReason: reason });
		result.closed += 1;
	};

	if (options.force) {
		for (const job of open) await done(job, options.force, null, Math.max(0, now - job.startedAt));
		return result;
	}

	const provider = deps.provider();
	const endpoint = ACTIVE.has(session.status) && provider ? await provider.endpoint(session.id).catch(() => null) : null;
	if (!endpoint) {
		// Sem container rodando: ninguém mais vai terminar estes jobs. (Sem provedor = servidor desligado: não adivinha.)
		if (!provider && ACTIVE.has(session.status)) {
			result.stillRunning = open.length;
			return result;
		}
		for (const job of open) await done(job, "lost", null, Math.max(0, now - job.startedAt));
		return result;
	}

	const client = deps.makeClient(endpoint);
	for (const job of open) {
		try {
			const snap = await client.execPoll(job.jobId, { waitMs: 0 });
			if (snap.running) {
				if (now - job.startedAt > jobCap + 60_000) {
					await client.execKill(job.jobId, "SIGKILL").catch(() => undefined);
					await done(job, "timeout", null, now - job.startedAt);
				} else {
					result.stillRunning += 1;
				}
				continue;
			}
			const tail = tailOf(`${snap.stdout}${snap.stderr}`);
			// Saída já transmitida durante o run está no histórico: reenviar o fim duplicaria.
			if (tail.trim() && !job.streamed) await deps.emit(session, { type: "shell_output", sessionId: session.id, callId: job.callId, jobId: job.jobId, chunk: `${tail}\n` });
			const reason: DevShellEndedReason = snap.timedOut ? "timeout" : snap.status === "killed" ? "killed" : "exit";
			await done(job, reason, snap.exitCode, snap.durationMs);
		} catch (error) {
			if (error instanceof DevSandboxError && error.status === 404) await done(job, "lost", null, Math.max(0, now - job.startedAt));
			else result.stillRunning += 1; // container inacessível agora: tenta no próximo ciclo
		}
	}
	return result;
}

export type DevJobWatcherOptions = DevJobDeps & {
	/** Sessões que podem ter jobs rodando (RUNNING/IDLE). */
	listActiveSessions: () => Promise<DevJobSession[]>;
	/**
	 * A conversa tem um run do agente ativo? Enquanto houver, é ele quem acompanha os próprios jobs
	 * (evita `shell_done`/saída duplicados); o vigia só fecha o que ficou para trás.
	 */
	hasActiveRun?: (session: DevJobSession) => Promise<boolean>;
	/** Jobs rodando no container agora (`null` = não deu para saber). Evita a consulta pesada ao banco quando não há nada aberto. */
	probeRunning?: (session: DevJobSession) => Promise<number | null>;
	/** Estado entre passadas: sessões que tinham jobs rodando (para fechar quando terminarem). */
	state?: Map<string, number>;
	intervalMs?: number;
	log?: (message: string) => void;
};

/** Uma passada do vigia (exportada para teste). */
export async function watchDevJobsOnce(options: DevJobWatcherOptions): Promise<ReconcileResult> {
	const total: ReconcileResult = { closed: 0, stillRunning: 0 };
	for (const session of await options.listActiveSessions()) {
		try {
			if (options.hasActiveRun && (await options.hasActiveRun(session).catch(() => false))) continue;
			if (options.probeRunning && options.state) {
				const running = await options.probeRunning(session).catch(() => null);
				const before = options.state.get(session.id);
				if (running !== null) options.state.set(session.id, running);
				// Container informou 0 jobs e nada rodava antes (e já o conhecemos): sem consulta ao banco.
				if (running === 0 && before === 0) continue;
			}
			const r = await reconcileSessionJobs(session, options);
			total.closed += r.closed;
			total.stillRunning += r.stillRunning;
		} catch (error) {
			(options.log ?? console.warn)(`[dev-jobs] falha na sessão ${session.id}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return total;
}

/**
 * Varredura de SEGURANÇA (a cada 5 min): o fim normal de um job chega por callback do container
 * (dev-job-callback.ts). Isto só cobre o que não tem aviso: container que caiu/OOM/foi recriado, job
 * perdido, callback que não chegou, container antigo sem a variável. A sonda barata de saúde vem antes
 * de qualquer consulta ao banco.
 */
export const DEV_JOB_SWEEP_INTERVAL_MS = 5 * 60_000;

export function startDevJobSweep(options: DevJobWatcherOptions): () => void {
	let running = false;
	options = { ...options, state: options.state ?? new Map<string, number>() };
	const timer = setInterval(() => {
		if (running) return;
		running = true;
		void watchDevJobsOnce(options)
			.catch((error) => console.error("[dev-jobs] passada falhou", error))
			.finally(() => {
				running = false;
			});
	}, options.intervalMs ?? DEV_JOB_SWEEP_INTERVAL_MS);
	timer.unref?.();
	return () => clearInterval(timer);
}

/** Dependências de produção (banco + provedor Docker); a rota e o processo principal compartilham. */
export function createDefaultDevJobDeps(provider: () => DevSandboxProvider | null): DevJobDeps {
	return {
		listOpenJobs: async (session) => {
			const open = computeOpenDevJobs(await listDevSessionJobEvents(session));
			if (!open.length) return open;
			const streamed = await listDevJobIdsWithOutput(session, open.map((job) => job.jobId)).catch(() => new Set<string>());
			return open.map((job) => (streamed.has(job.jobId) ? { ...job, streamed: true } : job));
		},
		emit: async (session, event) => {
			if (!session.conversationId) return;
			try {
				const runId = await getRunIdForDevEvents(session.conversationId);
				if (runId) await appendRunEvent(runId, event.type, event);
				// Hub em tempo real: o job mexeu na sessão (saída/fim); o cartão se atualiza sem consulta periódica.
				if (devJobEventThrottle(`${session.id}:${event.type}`)) {
					const owner = await prisma.conversation.findUnique({ where: { id: session.conversationId }, select: { userId: true } }).catch(() => null);
					void publishUserEvent(owner?.userId, "dev-job", { sessionId: session.id, conversationId: session.conversationId, kind: event.type });
				}
			} catch (error) {
				console.warn("dev job event failed", error instanceof Error ? error.message : "unknown");
			}
		},
		provider,
		makeClient: (endpoint) => createDevClient(endpoint),
	};
}
