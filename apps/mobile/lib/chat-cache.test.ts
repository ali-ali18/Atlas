import { describe, expect, it } from "vitest";
import { CHAT_CACHE_MAX_AGE_MS, CHAT_CACHE_MAX_BYTES, CHAT_CACHE_MAX_TEXT, createChatCacheWriter, CHAT_CACHE_MAX_ITEMS, chatCacheKey, clearChatCache, loadChatCache, parseChat, saveChatCache, serializeChat } from "./chat-cache";
import type { ChatItem } from "./chat-types";
import type { CacheStorage } from "./home-cache";

function memoryStorage(initial: Record<string, string> = {}): CacheStorage & { data: Map<string, string> } {
	const data = new Map(Object.entries(initial));
	return {
		data,
		getItem: async (key) => data.get(key) ?? null,
		setItem: async (key, value) => void data.set(key, value),
		removeItem: async (key) => void data.delete(key),
		getAllKeys: async () => [...data.keys()],
	};
}

const NOW = Date.parse("2026-11-02T12:00:00Z");
const msgs: ChatItem[] = [
	{ id: "1", kind: "user", text: "oi", createdAt: "2026-11-01T10:00:00Z" },
	{ id: "2", kind: "assistant", text: "**olá**", createdAt: "2026-11-01T10:00:05Z" },
	{ id: "3", kind: "task-list", runId: "r1", items: [{ content: "a", status: "completed" }] },
	{ id: "4", kind: "web-card", card: "chart", title: "Gráfico", key: "chart:1" },
	{ id: "5", kind: "marker", text: "Conversa compactada · 10 → 2" },
];

describe("cache do chat", () => {
	it("a chave leva servidor, e-mail (sem caixa) e conversa", () => {
		expect(chatCacheKey("https://a.test", "Dono@Ex.com", "c1")).toBe("atlas.chat.v1:https://a.test|dono@ex.com|c1");
		expect(chatCacheKey("https://a.test", "a@b.c", "c1")).not.toBe(chatCacheKey("https://a.test", "a@b.c", "c2"));
		expect(chatCacheKey("https://a.test", "a@b.c", "c1")).not.toBe(chatCacheKey("https://a.test", "x@b.c", "c1"));
	});
	it("guarda e lê de volta o que o fio desenha", async () => {
		const storage = memoryStorage();
		await saveChatCache(storage, "k", msgs, NOW);
		expect((await loadChatCache(storage, "k", NOW + 1000))?.items).toEqual(msgs);
	});
	it("não grava balão otimista, fala em andamento nem cartão que espera resposta", () => {
		const items: ChatItem[] = [
			{ id: "msg-1-a", kind: "user", text: "no ar" },
			{ id: "cu-1", kind: "assistant", text: "chegando" },
			{ id: "c", kind: "confirm", confirmId: "k", title: "Criar?", status: "pending" },
			{ id: "q", kind: "questionnaire", questionnaireId: "q", title: "Qual?", items: [], status: "pending" },
			{ id: "ok", kind: "confirm", confirmId: "k2", title: "Feito", status: "approved" },
		];
		const parsed = parseChat(serializeChat(items, NOW), NOW);
		expect(parsed?.items.map((item) => item.id)).toEqual(["ok"]);
	});
	it("só o fim da conversa e só as chaves que a tela usa", () => {
		const many: ChatItem[] = Array.from({ length: 100 }, (_, i) => ({ id: `m${i}`, kind: "user" as const, text: `t${i}` }));
		const parsed = parseChat(serializeChat(many, NOW), NOW)!;
		expect(parsed.items).toHaveLength(CHAT_CACHE_MAX_ITEMS);
		expect(parsed.items.at(-1)?.id).toBe("m99");
		const withExtra = JSON.parse(serializeChat(msgs, NOW));
		expect(Object.keys(withExtra.items[0]).sort()).toEqual(["createdAt", "id", "kind", "text"]);
		const raw = JSON.stringify({ v: 1, savedAt: NOW, items: [{ id: "1", kind: "user", text: "x", token: "segredo", cookie: "c" }] });
		expect(JSON.stringify(parseChat(raw, NOW))).not.toContain("segredo");
	});
	it("o valor fica bem abaixo do limite do armazenamento", () => {
		const big: ChatItem[] = Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, kind: "assistant" as const, text: "x".repeat(20_000) }));
		const text = serializeChat(big, NOW);
		expect(text.length).toBeLessThanOrEqual(CHAT_CACHE_MAX_BYTES);
		expect(parseChat(text, NOW)?.items.at(-1)?.id).toBe("m39");
	});
	it("texto estranho, outra versão e cache velho viram nada", () => {
		expect(parseChat(null, NOW)).toBeNull();
		expect(parseChat("não é json", NOW)).toBeNull();
		expect(parseChat(JSON.stringify({ v: 99, savedAt: NOW, items: [] }), NOW)).toBeNull();
		expect(parseChat(serializeChat(msgs, NOW), NOW + CHAT_CACHE_MAX_AGE_MS + 1)).toBeNull();
		expect(parseChat(JSON.stringify({ v: 1, savedAt: NOW, items: [{ id: 3 }, null, { id: "a", kind: "nope" }] }), NOW)?.items).toEqual([]);
	});
	it("armazenamento que falha não derruba a tela", async () => {
		const broken: CacheStorage = { getItem: async () => Promise.reject(new Error("x")), setItem: async () => Promise.reject(new Error("x")), removeItem: async () => undefined, getAllKeys: async () => Promise.reject(new Error("x")) };
		await expect(saveChatCache(broken, "k", msgs, NOW)).resolves.toBeUndefined();
		expect(await loadChatCache(broken, "k", NOW)).toBeNull();
		expect(await clearChatCache(broken)).toBe(false);
	});
	it("clearChatCache apaga o chat de todas as contas e versões, e só ele", async () => {
		const storage = memoryStorage({ "atlas.chat.v1:s|a|c1": "1", "atlas.chat.v0:s|b|c2": "2", "atlas.home.v2:s|a": "3", outro: "4" });
		expect(await clearChatCache(storage)).toBe(true);
		expect([...storage.data.keys()].sort()).toEqual(["atlas.home.v2:s|a", "outro"]);
	});
});

describe("escritor do cache (época)", () => {
	it("gravação em voo quando a conta sai se desfaz ao terminar", async () => {
		const storage = memoryStorage();
		let finish!: () => void;
		const gate = new Promise<void>((resolve) => (finish = resolve));
		const slow: CacheStorage = { ...storage, setItem: async (key, value) => (await gate, storage.setItem(key, value)) };
		const writer = createChatCacheWriter(slow);
		const pending = writer.write("k", msgs, NOW);
		writer.invalidate(); // sair / trocar de conta
		finish();
		await pending;
		expect(storage.data.has("k")).toBe(false);
	});
	it("gravação normal fica", async () => {
		const storage = memoryStorage();
		await createChatCacheWriter(storage).write("k", msgs, NOW);
		expect(storage.data.has("k")).toBe(true);
	});
	it("cada mensagem vai ao disco com no máximo ~4 mil caracteres", () => {
		const parsed = parseChat(serializeChat([{ id: "1", kind: "assistant", text: "x".repeat(50_000) }], NOW), NOW);
		expect(parsed?.items[0]).toMatchObject({ kind: "assistant" });
		expect((parsed?.items[0] as { text: string }).text).toHaveLength(CHAT_CACHE_MAX_TEXT);
		expect(CHAT_CACHE_MAX_TEXT).toBe(4_000);
	});
});
