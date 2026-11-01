import { describe, expect, it } from "vitest";
import { CACHE_MAX_AGE_MS, CACHE_VERSION, cacheKey, clearHomeCache, loadHomeCache, parseCache, saveHomeCache, serializeCache, type CacheStorage } from "./home-cache";
import type { HomeBot, HomeSnapshot } from "./home-types";

const bot: HomeBot = { id: "b1", name: "Cookie", color: "#0f0", shape: "blob", pinned: true, pinOrder: 0, sectionId: null, memberIds: [], isPrimary: false, unread: false, lastAt: "2026-10-05T12:00:00Z", preview: "Oi", previewSent: false };
const snapshot: HomeSnapshot = { bots: [bot], sections: [{ id: "s1", name: "Codding", order: 0 }] };

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
	it("versão 2: o v1 (Bot inteiro) é descartado", () => {
		expect(CACHE_VERSION).toBe(2);
		const v1 = JSON.stringify({ v: 1, savedAt: 1, bots: [{ id: "b1", name: "x", memberIds: [], lastMessage: null }], sections: [] });
		expect(parseCache(v1, 2)).toBeNull();
	});
	it("o que vai para o disco não tem política, descrição nem o texto inteiro", () => {
		const fat = { ...bot, policyJson: { limite: 1 }, description: "segredo", openRouterModel: "m", lastMessage: { content: "texto completo e longo" } } as unknown as HomeBot;
		const raw = serializeCache({ bots: [fat], sections: [{ id: "s", name: "S", order: 1, createdAt: "x" } as never] }, 1);
		expect(raw).not.toMatch(/policyJson|description|openRouterModel|lastMessage|texto completo|createdAt/);
		expect(JSON.parse(raw).bots[0]).toEqual(bot);
	});
	it("a prévia guardada é a truncada que a home desenha", () => {
		const curta = { ...bot, preview: "a".repeat(141) };
		expect(parseCache(serializeCache({ bots: [curta], sections: [] }, 1), 2)?.snapshot.bots[0]?.preview.length).toBe(141);
	});
	it("texto estranho, item malformado e velho demais", () => {
		expect(parseCache(null, 0)).toBeNull();
		expect(parseCache("{oops", 0)).toBeNull();
		expect(parseCache(JSON.stringify({ v: 2, savedAt: 1, bots: "x", sections: [] }), 2)).toBeNull();
		const mixed = JSON.stringify({ v: 2, savedAt: 1, bots: [bot, { id: 3 }], sections: [{ id: 1 }] });
		expect(parseCache(mixed, 2)?.snapshot).toEqual({ bots: [bot], sections: [] });
		expect(parseCache(serializeCache(snapshot, 0), CACHE_MAX_AGE_MS + 1)).toBeNull();
	});
	it("a chave separa servidor e conta", () => {
		expect(cacheKey("https://a.test", "Dono@X.com")).toBe(cacheKey("https://a.test", "dono@x.com"));
		expect(cacheKey("https://a.test", "a@x.com")).not.toBe(cacheKey("https://b.test", "a@x.com"));
		expect(cacheKey("https://a.test", "a@x.com")).not.toBe(cacheKey("https://a.test", "b@x.com"));
	});
	it("salva, carrega e limpa só o que é da home (inclusive chaves de versões antigas)", async () => {
		const storage = memory({ "atlas.server-url": "keep", "atlas.home.v1:antiga": "{}" });
		const key = cacheKey("https://a.test", "a@x.com");
		await saveHomeCache(storage, key, snapshot, 5);
		expect((await loadHomeCache(storage, key, 6))?.snapshot).toEqual(snapshot);
		expect(await clearHomeCache(storage)).toBe(true);
		expect(await loadHomeCache(storage, key, 6)).toBeNull();
		expect(storage.data.has("atlas.home.v1:antiga")).toBe(false);
		expect(storage.data.get("atlas.server-url")).toBe("keep");
	});
	it("falha do armazenamento não lança; a limpeza avisa com false", async () => {
		const storage = memory({}, true);
		await expect(saveHomeCache(storage, "k", snapshot, 1)).resolves.toBeUndefined();
		expect(await loadHomeCache(storage, "k", 1)).toBeNull();
		expect(await clearHomeCache(storage)).toBe(false);
	});
});
