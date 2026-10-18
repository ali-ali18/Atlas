/** Cache do catálogo compartilhado por todos os callers de um processo. */
export function createModelCatalogCache<T>(
	load: () => Promise<T>,
	options: {
		ttlMs?: number;
		cooldownMs?: number;
		now?: () => number;
		onError?: () => void;
	} = {},
) {
	const ttlMs = options.ttlMs ?? 3_600_000;
	const cooldownMs = options.cooldownMs ?? 30_000;
	if (
		![ttlMs, cooldownMs].every((value) => Number.isFinite(value) && value > 0)
	) {
		throw new RangeError("Intervalo de cache inválido");
	}
	const now = options.now ?? Date.now;
	let cache: { value: T; at: number } | null = null;
	let inflight: Promise<T | null> | null = null;
	let retryAt = 0;
	function get(): Promise<T | null> {
		if (cache && now() - cache.at < ttlMs) return Promise.resolve(cache.value);
		if (inflight) return inflight;
		if (now() < retryAt) return Promise.resolve(cache?.value ?? null);
		inflight = Promise.resolve()
			.then(load)
			.then(
				(value) => {
					cache = { value, at: now() };
					retryAt = 0;
					return value;
				},
				() => {
					retryAt = now() + cooldownMs;
					try {
						options.onError?.();
					} catch {
						/* Logging cannot break background refresh. */
					}
					return cache?.value ?? null;
				},
			)
			.finally(() => {
				inflight = null;
			});
		return inflight;
	}
	return {
		get,
		peek(): T | null {
			// O mesmo inflight/cooldown também vale para refresh sem espera.
			void get();
			return cache?.value ?? null;
		},
	};
}
