import type { BotExchangeItem } from "@workspace/shared";
import { describe, expect, it, vi } from "vitest";
import { ChatApiError, isUnauthorized } from "./chat-api";
import { fetchBotExchange, flattenBotExchange, hasFocus, mergeExchangeItems, parseExchangePage, stampBreaks } from "./bot-exchange";

const item = (id: string, over: Partial<BotExchangeItem> = {}): BotExchangeItem => ({
	id,
	rootId: id,
	fromBotId: "grok",
	toBotId: "bob",
	title: "Oi",
	content: "Olá, Bobinho",
	replyContent: "Olá!",
	status: "replied",
	createdAt: "2026-11-03T10:00:00.000Z",
	repliedAt: "2026-11-03T10:01:00.000Z",
	...over,
});

describe("flattenBotExchange", () => {
	it("pedido e resposta viram duas falas em ordem, com quem é 'self'", () => {
		const entries = flattenBotExchange([item("m1")], "bob");
		expect(entries.map((entry) => [entry.key, entry.self, entry.authorId])).toEqual([["m1:req", false, "grok"], ["m1:reply", true, "bob"]]);
		expect(entries[0]).toMatchObject({ title: "Oi", text: "Olá, Bobinho" });
	});
	it("sem resposta só o pedido; resposta vazia não vira fala", () => {
		expect(flattenBotExchange([item("m1", { replyContent: null, repliedAt: null })], "bob")).toHaveLength(1);
		expect(flattenBotExchange([item("m1", { replyContent: "  " })], "bob")).toHaveLength(1);
	});
	it("ordena por horário entre trocas", () => {
		const entries = flattenBotExchange([item("m2", { createdAt: "2026-11-03T11:00:00.000Z", repliedAt: "2026-11-03T11:02:00.000Z" }), item("m1")], "bob");
		expect(entries.map((entry) => entry.key)).toEqual(["m1:req", "m1:reply", "m2:req", "m2:reply"]);
	});
});

describe("hasFocus", () => {
	it("acha a troca da fala pelo id; sem foco, nada a buscar", () => {
		expect(hasFocus([item("m1"), item("m2")], "m2:req")).toBe(true);
		expect(hasFocus([item("m1")], "m9:reply")).toBe(false);
		expect(hasFocus([], null)).toBe(true);
	});
});

describe("401", () => {
	it("sessão recusada vira erro que o app trata como saída (isUnauthorized)", async () => {
		const apiFetch = vi.fn(async (_path: string, _init?: RequestInit) => new Response("{}", { status: 401 }));
		const error = await fetchBotExchange(apiFetch, "a", "b").catch((reason: unknown) => reason);
		expect(error).toBeInstanceOf(ChatApiError);
		expect(isUnauthorized(error)).toBe(true);
	});
});

describe("stampBreaks", () => {
	it("a primeira fala e as que vêm depois de uma pausa levam data e hora", () => {
		const entries = flattenBotExchange([item("m1"), item("m2", { createdAt: "2026-11-03T14:00:00.000Z", repliedAt: "2026-11-03T14:01:00.000Z" })], "bob");
		expect([...stampBreaks(entries)]).toEqual(["m1:req", "m2:req"]);
		expect(stampBreaks([])).toEqual(new Set());
	});
});

describe("mergeExchangeItems e parseExchangePage", () => {
	it("páginas mais antigas entram antes, sem repetir", () => {
		expect(mergeExchangeItems([item("m0"), item("m1")], [item("m1"), item("m2")]).map((entry) => entry.id)).toEqual(["m0", "m1", "m2"]);
	});
	it("descarta troca sem campos e preenche o que falta", () => {
		const page = parseExchangePage({ messages: [{ id: "x" }, { ...item("m1"), title: undefined, replyContent: undefined, repliedAt: undefined }], nextCursor: "c" });
		expect(page?.messages).toHaveLength(1);
		expect(page?.messages[0]).toMatchObject({ title: "", replyContent: null, repliedAt: null });
		expect(page?.nextCursor).toBe("c");
		expect(parseExchangePage({})).toBeNull();
	});
});

describe("fetchBotExchange", () => {
	it("usa o endpoint escopado do web, com os ids e o cursor codificados", async () => {
		const apiFetch = vi.fn(async (_path: string, _init?: RequestInit) => new Response(JSON.stringify({ messages: [item("m1")], nextCursor: null })));
		const page = await fetchBotExchange(apiFetch, "bob/1", "grok", { limit: 50, cursor: "2026-11-03T10:00:00.000Z" });
		expect(apiFetch).toHaveBeenCalledWith("/v1/bots/bob%2F1/exchanges/grok?limit=50&cursor=2026-11-03T10%3A00%3A00.000Z", expect.anything());
		expect(page.messages).toHaveLength(1);
	});
	it("404 (bot de outro dono) vira erro amigável", async () => {
		const apiFetch = vi.fn(async (_path: string, _init?: RequestInit) => new Response("{}", { status: 404 }));
		await expect(fetchBotExchange(apiFetch, "a", "b")).rejects.toMatchObject({ status: 404, message: "Conversa não encontrada." });
		await expect(fetchBotExchange(apiFetch, "a", "b")).rejects.toBeInstanceOf(ChatApiError);
	});
});
