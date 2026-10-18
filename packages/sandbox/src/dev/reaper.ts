import type { DevSandboxProvider } from "./provider.js";

/**
 * Descansa sessões de desenvolvimento ociosas: **para** o container após
 * `idleMs` sem atividade (workspace preservado, status STOPPED) e, depois de
 * `expireMs` parada, remove container e volume (status EXPIRED).
 * O banco é injetado (o pacote sandbox não depende do db).
 */

export type DevReaperSession = { id: string; userId: string; conversationId?: string | null };

export interface DevReaperStore {
	/** Sessões RUNNING/IDLE sem atividade desde `before`. */
	listIdle(before: Date): Promise<DevReaperSession[]>;
	/** Sessões STOPPED sem atividade desde `before`. */
	listExpired(before: Date): Promise<DevReaperSession[]>;
	setStatus(id: string, status: "STOPPED" | "EXPIRED" | "ERROR", lastError?: string): Promise<void>;
	/** Jobs em segundo plano sem fim registrado (início em ms). Conta como atividade até o teto do job. */
	listOpenJobs?(session: DevReaperSession): Promise<Array<{ startedAt: number }>>;
	/** Depois de parar/expirar: o chamador registra o fim (`shell_done`) de cada job ainda aberto. */
	onEnded?(session: DevReaperSession, reason: "stopped" | "timeout" | "lost"): Promise<void>;
}

/** Teto de um comando em segundo plano no container (exec-jobs.mjs MAX_TIMEOUT_MS). */
export const DEV_REAPER_JOB_CAP_MS = 30 * 60_000;

export type DevReaperOptions = {
	provider: DevSandboxProvider;
	store: DevReaperStore;
	idleMs: number;
	expireMs: number;
	/** Quanto tempo um job em segundo plano segura o container (padrão 30 min). */
	jobCapMs?: number;
	now?: () => number;
	log?: (message: string) => void;
};

export type DevReapResult = { stopped: string[]; expired: string[]; skippedBusy: string[]; failed: string[] };

/** Uma passada (exportada para teste). */
export async function reapDevSessionsOnce(options: DevReaperOptions): Promise<DevReapResult> {
	const now = options.now?.() ?? Date.now();
	const log = options.log ?? ((message: string) => console.log(`[dev-reaper] ${message}`));
	const jobCap = options.jobCapMs ?? DEV_REAPER_JOB_CAP_MS;
	const result: DevReapResult = { stopped: [], expired: [], skippedBusy: [], failed: [] };

	for (const session of await options.store.listIdle(new Date(now - options.idleMs))) {
		try {
			// Comando em segundo plano rodando conta como atividade até o teto do job (30 min); depois mata e registra "timeout".
			const busy = (await options.provider.runningJobs(session.id)) > 0;
			let reason: "stopped" | "timeout" = "stopped";
			if (busy) {
				const open = (await options.store.listOpenJobs?.(session)) ?? null;
				const oldest = open && open.length ? Math.min(...open.map((job) => job.startedAt)) : null;
				if (oldest !== null) {
					if (now - oldest < jobCap) {
						result.skippedBusy.push(session.id);
						continue;
					}
					reason = "timeout";
				} else {
					// Sem registro dos jobs: folga de 3x o ocioso (comportamento anterior).
					const stillIdle = await options.store.listIdle(new Date(now - options.idleMs * 3));
					if (!stillIdle.some((item) => item.id === session.id)) {
						result.skippedBusy.push(session.id);
						continue;
					}
				}
			}
			await options.provider.stop(session.id);
			await options.store.setStatus(session.id, "STOPPED");
			await options.store.onEnded?.(session, reason).catch((error) => log(`falha ao encerrar jobs de ${session.id}: ${error instanceof Error ? error.message : String(error)}`));
			result.stopped.push(session.id);
			log(`parou sessão ociosa ${session.id}`);
		} catch (error) {
			result.failed.push(session.id);
			log(`falha ao parar ${session.id}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	for (const session of await options.store.listExpired(new Date(now - options.expireMs))) {
		try {
			await options.provider.destroy(session.id, { removeVolume: true });
			await options.store.setStatus(session.id, "EXPIRED");
			await options.store.onEnded?.(session, "lost").catch(() => undefined);
			result.expired.push(session.id);
			log(`expirou sessão ${session.id}`);
		} catch (error) {
			result.failed.push(session.id);
			log(`falha ao expirar ${session.id}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return result;
}

export function startDevSessionReaper(options: DevReaperOptions & { intervalMs?: number }): () => void {
	let running = false;
	const timer = setInterval(() => {
		if (running) return;
		running = true;
		void reapDevSessionsOnce(options)
			.catch((error) => console.error("[dev-reaper] passada falhou", error))
			.finally(() => {
				running = false;
			});
	}, options.intervalMs ?? 60_000);
	timer.unref?.();
	return () => clearInterval(timer);
}

export const DEV_CACHE_SWEEP_INTERVAL_MS = 24 * 60 * 60_000;

/** Uma passada de limpeza dos caches de ambiente (sem uso há 7 dias; teto de tamanho em LRU). Nunca lança. */
export async function sweepEnvCachesOnce(provider: DevSandboxProvider, log: (message: string) => void = (message) => console.log(`[dev-cache] ${message}`)): Promise<number> {
	if (!provider.sweepEnvCaches) return 0;
	try {
		const result = await provider.sweepEnvCaches();
		for (const item of result.evicted) log(`cache ${item.name} removido (${item.reason === "expired" ? "sem uso" : "teto de tamanho"})`);
		return result.evicted.length;
	} catch (error) {
		log(`limpeza de caches falhou: ${error instanceof Error ? error.message : String(error)}`);
		return 0;
	}
}

/** Limpeza diária dos caches de ambiente (primeira passada 2 minutos depois de subir). */
export function startDevEnvCacheSweep(provider: DevSandboxProvider, options: { intervalMs?: number; firstDelayMs?: number } = {}): () => void {
	let running = false;
	const tick = () => {
		if (running) return;
		running = true;
		void sweepEnvCachesOnce(provider).finally(() => {
			running = false;
		});
	};
	const first = setTimeout(tick, options.firstDelayMs ?? 2 * 60_000);
	const timer = setInterval(tick, options.intervalMs ?? DEV_CACHE_SWEEP_INTERVAL_MS);
	first.unref?.();
	timer.unref?.();
	return () => {
		clearTimeout(first);
		clearInterval(timer);
	};
}
