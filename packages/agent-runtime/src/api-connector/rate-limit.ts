/**
 * Limite de taxa por conexão (espaçamento mínimo entre requisições) e cache
 * curto de leituras. Em memória do processo; o relógio e o sleep são
 * injetáveis para os testes não dependerem do tempo real.
 */

export type Clock = { now: () => number; sleep: (ms: number, signal?: AbortSignal) => Promise<void> };

export const realClock: Clock = {
	now: () => Date.now(),
	sleep: (ms, signal) =>
		new Promise((resolve) => {
			if (ms <= 0) return resolve();
			const timer = setTimeout(done, ms);
			function done() {
				clearTimeout(timer);
				signal?.removeEventListener("abort", done);
				resolve();
			}
			signal?.addEventListener("abort", done);
		}),
};

export class RateLimiter {
	private nextFree = 0;

	constructor(
		private rps: number,
		private readonly clock: Clock = realClock,
	) {}

	setRate(rps: number): void {
		this.rps = rps;
	}

	/** Reserva o próximo horário livre e espera até ele. */
	async acquire(signal?: AbortSignal): Promise<void> {
		const interval = 1000 / Math.max(0.1, this.rps);
		const now = this.clock.now();
		const start = Math.max(now, this.nextFree);
		this.nextFree = start + interval;
		await this.clock.sleep(start - now, signal);
	}

	/** O servidor pediu pausa (429): ninguém sai antes disso. */
	penalize(ms: number): void {
		this.nextFree = Math.max(this.nextFree, this.clock.now() + ms);
	}
}

const limiters = new Map<string, RateLimiter>();

export function limiterFor(connectionId: string, rps: number, clock: Clock = realClock): RateLimiter {
	let limiter = limiters.get(connectionId);
	if (!limiter) {
		limiter = new RateLimiter(rps, clock);
		limiters.set(connectionId, limiter);
	} else limiter.setRate(rps);
	return limiter;
}

/** Só testes. */
export function resetApiRateLimiters(): void {
	limiters.clear();
}

/** `Retry-After` em segundos ou data HTTP; limitado a `maxMs`. */
export function retryAfterMs(header: string | null, now: number, maxMs = 10_000): number | null {
	if (!header) return null;
	const seconds = Number(header);
	if (Number.isFinite(seconds)) return Math.min(maxMs, Math.max(0, seconds * 1000));
	const at = Date.parse(header);
	return Number.isFinite(at) ? Math.min(maxMs, Math.max(0, at - now)) : null;
}

export type CacheEntry = { at: number; value: string };

/** Cache curto de GET por usuário+conexão+URL. */
export class ReadCache {
	private readonly entries = new Map<string, CacheEntry>();

	constructor(
		private readonly ttlMs = 60_000,
		private readonly max = 200,
	) {}

	get(key: string, now: number): string | null {
		const hit = this.entries.get(key);
		if (!hit) return null;
		if (now - hit.at > this.ttlMs) {
			this.entries.delete(key);
			return null;
		}
		return hit.value;
	}

	set(key: string, value: string, now: number): void {
		if (this.entries.size >= this.max) {
			const oldest = this.entries.keys().next().value;
			if (oldest !== undefined) this.entries.delete(oldest);
		}
		this.entries.set(key, { at: now, value });
	}

	clear(): void {
		this.entries.clear();
	}
}

export const sharedApiReadCache = new ReadCache();
