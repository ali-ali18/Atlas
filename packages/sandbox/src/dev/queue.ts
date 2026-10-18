import type { DevTier } from "./config.js";
import type { DevSandboxProvider } from "./provider.js";

/**
 * Fila de admissão: sessões em QUEUED (sem vaga quando o agente pediu) são
 * tentadas de novo em segundo plano, da mais antiga para a mais nova, com
 * espera crescente por sessão. Quando uma vaga abre, o container sobe e a
 * sessão vira RUNNING (o painel acompanha pelo estado salvo da sessão).
 */

export type DevQueuedSession = { id: string; userId: string; tier: DevTier };

export interface DevQueueStore {
	/** Sessões em QUEUED, mais antigas primeiro. */
	listQueued(): Promise<DevQueuedSession[]>;
	markRunning(id: string, containerId: string): Promise<void>;
}

export type DevQueueOptions = {
	provider: DevSandboxProvider;
	store: DevQueueStore;
	/** Primeira espera depois de uma tentativa sem vaga. */
	baseDelayMs?: number;
	maxDelayMs?: number;
	now?: () => number;
	log?: (message: string) => void;
	/** Chamado quando uma sessão da fila ganha vaga e sobe. */
	onStarted?: (session: DevQueuedSession) => void | Promise<void>;
};

export type DevQueueResult = { started: string[]; waiting: string[]; failed: string[]; skipped: string[] };

/** Espera por sessão entre tentativas (cresce 2x, com teto). */
const attempts = new Map<string, { count: number; nextAt: number }>();

export function nextQueueDelay(count: number, baseMs: number, maxMs: number): number {
	return Math.min(maxMs, baseMs * 2 ** Math.max(0, count - 1));
}

/** Uma passada (exportada para teste). Para na primeira sessão sem vaga: as mais novas não furam a fila. */
export async function retryQueuedDevSessionsOnce(options: DevQueueOptions): Promise<DevQueueResult> {
	const now = options.now?.() ?? Date.now();
	const log = options.log ?? ((message: string) => console.log(`[dev-queue] ${message}`));
	const baseMs = options.baseDelayMs ?? 10_000;
	const maxMs = options.maxDelayMs ?? 120_000;
	const result: DevQueueResult = { started: [], waiting: [], failed: [], skipped: [] };
	const queued = await options.store.listQueued();
	const alive = new Set(queued.map((session) => session.id));
	for (const id of attempts.keys()) if (!alive.has(id)) attempts.delete(id);

	for (const session of queued) {
		const state = attempts.get(session.id);
		if (state && state.nextAt > now) {
			result.skipped.push(session.id);
			result.waiting.push(session.id);
			break;
		}
		try {
			const ensured = await options.provider.ensureRunning({ sessionId: session.id, userId: session.userId, tier: session.tier });
			if (ensured.status === "queued") {
				const count = (state?.count ?? 0) + 1;
				attempts.set(session.id, { count, nextAt: now + nextQueueDelay(count, baseMs, maxMs) });
				result.waiting.push(session.id);
				// A fila é FIFO: se a mais antiga não coube, as seguintes (mesma folga) também não.
				break;
			}
			attempts.delete(session.id);
			await options.store.markRunning(session.id, ensured.containerId);
			result.started.push(session.id);
			log(`sessão ${session.id} saiu da fila`);
			await options.onStarted?.(session);
		} catch (error) {
			result.failed.push(session.id);
			log(`falha ao tentar a sessão ${session.id}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return result;
}

export function startDevSessionQueue(options: DevQueueOptions & { intervalMs?: number }): () => void {
	let running = false;
	const timer = setInterval(() => {
		if (running) return;
		running = true;
		void retryQueuedDevSessionsOnce(options)
			.catch((error) => console.error("[dev-queue] passada falhou", error))
			.finally(() => {
				running = false;
			});
	}, options.intervalMs ?? 10_000);
	timer.unref?.();
	return () => clearInterval(timer);
}

/** Só para teste. */
export function resetDevQueueState() {
	attempts.clear();
}
