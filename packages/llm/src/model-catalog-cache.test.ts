import { expect, it } from "vitest";
import { createModelCatalogCache } from "./model-catalog-cache.js";
it("single-flight, stale em falha e cooldown também no peek", async () => {
	let now = 0,
		calls = 0,
		fail = false;
	const cache = createModelCatalogCache(
		async () => {
			calls++;
			if (fail) throw new Error("offline");
			return [calls];
		},
		{ now: () => now, ttlMs: 100, cooldownMs: 30 },
	);
	expect(
		await Promise.all(Array.from({ length: 20 }, () => cache.get())),
	).toEqual(Array(20).fill([1]));
	expect(calls).toBe(1);
	now = 101;
	fail = true;
	expect(await cache.get()).toEqual([1]);
	cache.peek();
	expect(await cache.get()).toEqual([1]);
	expect(calls).toBe(2);
	now = 132;
	fail = false;
	expect(await cache.get()).toEqual([3]);
});
it("sem cache falha fechada e aguarda cooldown", async () => {
	let calls = 0;
	const cache = createModelCatalogCache(async () => {
		calls++;
		throw new Error("offline");
	});
	expect(await cache.get()).toBeNull();
	expect(await cache.get()).toBeNull();
	expect(calls).toBe(1);
});
