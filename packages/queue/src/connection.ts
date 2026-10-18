import { Redis } from "ioredis";

const DEFAULT_REDIS_URL = "redis://127.0.0.1:6379";

export function resolveRedisUrl(envValue?: string): string {
	const trimmed = envValue?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_REDIS_URL;
}

/** Conexão Redis dedicada (uma por processo; BullMQ recomenda instâncias separadas para Queue e Worker). */
export function createRedisConnection(redisUrl?: string): Redis {
	return new Redis(resolveRedisUrl(redisUrl), {
		maxRetriesPerRequest: null,
	});
}
