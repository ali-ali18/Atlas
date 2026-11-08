import { describe, expect, it } from "vitest";
import { createRedisCvvEscrowBackend, type CvvEscrowRedis } from "./cvv-escrow-backend.js";

function fakeRedis() {
	const data = new Map<string, { v: string; px: number }>();
	const redis = {
		set: async (k: string, v: string, _px: string, ttl: number, nx?: string) => {
			if (nx === "NX" && data.has(k)) return null;
			data.set(k, { v, px: ttl });
			return "OK";
		},
		getdel: async (k: string) => {
			const e = data.get(k);
			data.delete(k);
			return e?.v ?? null;
		},
		del: async (k: string) => (data.delete(k) ? 1 : 0),
	};
	return { data, redis: redis as unknown as CvvEscrowRedis };
}

describe("backend Redis do CVV", () => {
	it("grava com TTL em ms, lê e apaga no mesmo passo (uso único)", async () => {
		const { data, redis } = fakeRedis();
		const b = createRedisCvvEscrowBackend(redis);
		await b.set("k", "selado", 900_000);
		expect(data.get("k")?.px).toBe(900_000);
		expect(await b.getdel("k")).toBe("selado");
		expect(await b.getdel("k")).toBeNull();
	});
	it("com nx não sobrescreve o valor que já existe (o do primeiro clique fica)", async () => {
		const { redis } = fakeRedis();
		const b = createRedisCvvEscrowBackend(redis);
		expect(await b.set("k", "primeiro", 1000, { nx: true })).toBe(true);
		expect(await b.set("k", "segundo", 1000, { nx: true })).toBe(false);
		expect(await b.getdel("k")).toBe("primeiro");
	});
	it("recusa TTL inválido e descarta", async () => {
		const { redis } = fakeRedis();
		const b = createRedisCvvEscrowBackend(redis);
		await expect(b.set("k", "v", 0)).rejects.toThrow();
		await b.set("k", "v", 10);
		await b.del("k");
		expect(await b.getdel("k")).toBeNull();
	});
});
