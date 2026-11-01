import { describe, expect, it } from "vitest";
import { CACHE_MAX_AGE_MS, cacheKey, clearHomeCache, loadHomeCache, parseCache, saveHomeCache, serializeCache, type CacheStorage } from "./home-cache";
import type { HomeSnapshot } from "./home-sync";

const snapshot = { bots: [{ id: "b1", name: "Cookie", memberIds: [], lastMessage: null }], sections: [{ id: "s1", name: "Codding", order: 0 }] } as unknown as HomeSnapshot;

function memory(initial: Record<string, string> = {}, failing = false): CacheStorage & { data: Map<string, string> } {
	const data = new Map(Object.entries(initial));
	const guard = () => {
		if (failing) throw new Error("disco cheio");
	};
	return {
		data,
		getItem: async (key) => (guard(), data.get(key) ?? null),
		setItem: async (key, value) => (guard(), void data.set(key, value)),
		removeItem: async (key) => (guard(), void data.delete(key)),
		getAllKeys: async () => (guard(), [...data.keys()]),
	};
}

describe("cache da home", () => {
	it("ida e volta", () => {
		expect(parseCache(serializeCache(snapshot, 1000), 2000)).toEqual({ snapshot, savedAt: 1000 });
	});
	it("texto estranho, outra versão e velho demais viram null", () => {
		expect(parseCache(null, 0)).toBeNull();
		expect(parseCache("{oops", 0)).toBeNull();
		expect(parseCache(JSON.stringify({ v: 2, savedAt: 1, bots: [], sections: [] }), 2)).toBeNull();
		expect(parseCache(JSON.stringify({ v: 1, savedAt: 1, bots: "x", sections: [] }), 2)).toBeNull();
		expect(parseCache(serializeCache(snapshot, 0), CACHE_MAX_AGE_MS + 1)).toBeNull();
	});
	it("a chave separa servidor e conta", () => {
		expect(cacheKey("https://a.test", "Dono@X.com")).toBe(cacheKey("https://a.test", "dono@x.com"));
		expect(cacheKey("https://a.test", "a@x.com")).not.toBe(cacheKey("https://b.test", "a@x.com"));
		expect(cacheKey("https://a.test", "a@x.com")).not.toBe(cacheKey("https://a.test", "b@x.com"));
	});
	it("salva, carrega e limpa só o que é da home", async () => {
		const storage = memory({ "atlas.server-url": "keep" });
		const key = cacheKey("https://a.test", "a@x.com");
		await saveHomeCache(storage, key, snapshot, 5);
		expect((await loadHomeCache(storage, key, 6))?.snapshot).toEqual(snapshot);
		await clearHomeCache(storage);
		expect(await loadHomeCache(storage, key, 6)).toBeNull();
		expect(storage.data.get("atlas.server-url")).toBe("keep");
	});
	it("falha do armazenamento não quebra", async () => {
		const storage = memory({}, true);
		await expect(saveHomeCache(storage, "k", snapshot, 1)).resolves.toBeUndefined();
		expect(await loadHomeCache(storage, "k", 1)).toBeNull();
		await expect(clearHomeCache(storage)).resolves.toBeUndefined();
	});
});
