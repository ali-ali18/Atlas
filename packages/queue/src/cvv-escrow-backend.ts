import type { Redis } from "ioredis";

/**
 * Backend do canal efêmero do CVV (F6.3) sobre o Redis. Guarda só TEXTO SELADO (quem sela é o motor), com TTL curto,
 * e `getdel` lê e apaga numa operação atômica: o segredo vale uma vez. Estrutura igual à porta `EscrowBackend` do motor.
 */
export type CvvEscrowBackend = {
	/** Com `nx`, só grava se a chave não existe (SET NX): devolve `false` se já havia valor, que fica intacto. */
	set(key: string, value: string, ttlMs: number, opts?: { nx?: boolean }): Promise<boolean>;
	getdel(key: string): Promise<string | null>;
	del(key: string): Promise<void>;
};

/** Subconjunto do ioredis usado (injetável em teste). */
export type CvvEscrowRedis = Pick<Redis, "set" | "getdel" | "del">;

export function createRedisCvvEscrowBackend(redis: CvvEscrowRedis): CvvEscrowBackend {
	return {
		async set(key, value, ttlMs, opts) {
			if (!Number.isInteger(ttlMs) || ttlMs <= 0) throw new RangeError("CVV TTL must be a positive integer");
			if (opts?.nx) return (await redis.set(key, value, "PX", ttlMs, "NX")) === "OK";
			await redis.set(key, value, "PX", ttlMs);
			return true;
		},
		async getdel(key) {
			return (await redis.getdel(key)) ?? null;
		},
		async del(key) {
			await redis.del(key);
		},
	};
}
