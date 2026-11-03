import { describe, expect, it } from "vitest";
import { CHAT_CACHE_VERSION, CHAT_CACHE_MAX_AGE_MS, CHAT_CACHE_MAX_BYTES, CHAT_CACHE_MAX_TEXT, createChatCacheWriter, CHAT_CACHE_MAX_ITEMS, chatCacheKey, clearChatCache, loadChatCache, parseChat, saveChatCache, serializeChat } from "./chat-cache";
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
		expect(chatCacheKey("https://a.test", "Dono@Ex.com", "c1")).toBe("atlas.chat.v3:https://a.test|dono@ex.com|c1");
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
		const raw = JSON.stringify({ v: CHAT_CACHE_VERSION, savedAt: NOW, items: [{ id: "1", kind: "user", text: "x", token: "segredo", cookie: "c" }] });
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
		expect(parseChat(JSON.stringify({ v: CHAT_CACHE_VERSION, savedAt: NOW, items: [{ id: 3 }, null, { id: "a", kind: "nope" }] }), NOW)?.items).toEqual([]);
	});
	it("armazenamento que falha não derruba a tela", async () => {
		const broken: CacheStorage = { getItem: async () => Promise.reject(new Error("x")), setItem: async () => Promise.reject(new Error("x")), removeItem: async () => undefined, getAllKeys: async () => Promise.reject(new Error("x")) };
		await expect(saveChatCache(broken, "k", msgs, NOW)).resolves.toBeUndefined();
		expect(await loadChatCache(broken, "k", NOW)).toBeNull();
		expect(await clearChatCache(broken)).toBe(false);
	});
	it("clearChatCache apaga o chat de todas as contas e versões, e só ele", async () => {
		const storage = memoryStorage({ "atlas.chat.v3:s|a|c1": "1", "atlas.chat.v0:s|b|c2": "2", "atlas.home.v2:s|a": "3", outro: "4" });
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

describe("cache do chat: cartão de painel", () => {
	const page = (extra: Record<string, unknown> = {}) => ({ id: "p", kind: "web-card", card: "page", title: "Vendas", key: "page:p1", ...extra });
	it("guarda pageId, revisão e fontes", () => {
		const item: ChatItem = { id: "p", kind: "web-card", card: "page", title: "Vendas", key: "page:p1", pageId: "p1", revision: 3, sourceCount: 2 };
		expect(parseChat(serializeChat([item], NOW), NOW)?.items).toEqual([item]);
	});
	it("cache antigo sem pageId continua válido e abre no navegador", () => {
		const parsed = parseChat(JSON.stringify({ v: CHAT_CACHE_VERSION, savedAt: NOW, items: [page()] }), NOW);
		expect(parsed?.items).toEqual([page()]);
		expect(parsed?.items[0]).not.toHaveProperty("pageId");
	});
	it("descarta pageId inválido ou longo e campos de painel em outro tipo de cartão", () => {
		const bad = parseChat(JSON.stringify({ v: CHAT_CACHE_VERSION, savedAt: NOW, items: [page({ pageId: 5, revision: "x", sourceCount: null }), page({ pageId: "x".repeat(200) }), { ...page({ pageId: "p1" }), card: "chart" }] }), NOW);
		expect(bad?.items.map((item) => ("pageId" in item ? item.pageId : undefined))).toEqual([undefined, undefined, undefined]);
	});
});

describe("cache do chat: cartão de arquivo", () => {
	const file = (extra: Record<string, unknown> = {}) => ({ id: "f", kind: "web-card", card: "file", title: "a.md", key: "file:f1", ...extra });
	it("guarda fileId, mime e tamanho (o cartão volta a abrir a folha)", () => {
		const item: ChatItem = { id: "f", kind: "web-card", card: "file", title: "a.md", key: "file:f1", fileId: "f1", mime: "text/markdown", size: 120 };
		expect(parseChat(serializeChat([item], NOW), NOW)?.items).toEqual([item]);
	});
	it("descarta id, mime e tamanho inválidos, e campos de arquivo em outro cartão", () => {
		const bad = parseChat(JSON.stringify({ v: CHAT_CACHE_VERSION, savedAt: NOW, items: [file({ fileId: 5, mime: 1, size: "x" }), file({ fileId: "x".repeat(200) }), file({ fileId: "f1", mime: "m".repeat(200), size: -1 }), { ...file({ fileId: "f1" }), card: "chart" }] }), NOW);
		expect(bad?.items).toEqual([file(), file(), file({ fileId: "f1" }), { ...file(), card: "chart" }]);
	});
});

describe("cartões de proposta no cache", () => {
	const proposal: ChatItem = { id: "m1", kind: "bot-proposal", proposalId: "p1", status: "approved", name: "Estoquinho", description: "Cuida do estoque", color: "#1084FE", shape: "hex", model: "a/b", skills: ["x-y"], firstTask: "Tarefa", botId: "bot-9" };
	const profile: ChatItem = { id: "m2", kind: "bot-profile", proposalId: "pf1", botId: "bot1", status: "rejected", fields: ["name", "description"], before: { name: "A", snippet: "", description: null, openRouterModel: null }, after: { name: "B", description: "Nova" } };
	it("o decidido vai e volta do disco; o pendente fica de fora (o estado de verdade vem do servidor)", () => {
		const pending = { ...proposal, id: "m3", proposalId: "p2", status: "pending" } as ChatItem;
		const loaded = parseChat(serializeChat([proposal, profile, pending], 1_000), 1_000)!;
		expect(loaded.items).toEqual([proposal, profile]);
	});
	it("não guarda os campos do aparelho (applying, error) nem chave extra", () => {
		const raw = serializeChat([{ ...proposal, applying: true, error: "x" } as ChatItem], 1_000);
		expect(raw).not.toContain("applying");
		expect(raw).not.toContain("\"error\"");
	});
	it("item torto no disco é descartado", () => {
		const raw = JSON.stringify({ v: CHAT_CACHE_VERSION, savedAt: 1_000, items: [{ id: "x", kind: "bot-proposal", proposalId: "p" }, { id: "y", kind: "bot-profile", proposalId: "p", botId: "b", status: "pending", fields: ["zzz"], before: {}, after: {} }] });
		expect(parseChat(raw, 1_000)!.items).toEqual([]);
	});
});

describe("versão do cache", () => {
	it("o cache da versão anterior (com web-card de proposta) é descartado", () => {
		const old = JSON.stringify({ v: CHAT_CACHE_VERSION - 1, savedAt: NOW, items: [{ id: "1", kind: "web-card", card: "proposal", title: "Proposta de bot", key: "bot-proposal:1" }] });
		expect(parseChat(old, NOW)).toBeNull();
	});
});
