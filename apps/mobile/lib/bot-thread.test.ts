import { describe, expect, it } from "vitest";
import { botExchangeLabel, exchangePeerId, exchangeStamp, groupBotItems, isBotSpeech } from "./bot-thread";
import { parseChat, serializeChat } from "./chat-cache";
import { sessionMessageToItem } from "./chat-thread";
import type { ChatItem } from "./chat-types";

const NOW = Date.parse("2026-11-03T12:00:00.000Z");
const grok = { fromBotId: "b-grok", fromBotName: "Grok Bot" };
const request = (id: string, botMessageId = `bm-${id}`): ChatItem => ({ id, kind: "user", text: "Olá, Cookie", createdAt: "2026-11-03T10:00:00.000Z", bot: { kind: "request", ...grok, botMessageId } });
const answer = (id: string, botMessageId = "bm-1"): ChatItem => ({ id, kind: "assistant", text: "Oi!", createdAt: "2026-11-03T10:01:00.000Z", bot: { kind: "answer", botMessageId } });
const reply = (id: string): ChatItem => ({ id, kind: "user", text: "pronto", bot: { kind: "reply", ...grok, botMessageId: "bm-r" } });
const user = (id: string, text = "oi"): ChatItem => ({ id, kind: "user", text });
const bot = (id: string, text = "claro"): ChatItem => ({ id, kind: "assistant", text });

const row = (over: Record<string, unknown>) => ({ id: "m1", conversationId: "c1", role: "user", content: "x", createdAt: "2026-11-03T10:00:00.000Z", ...over }) as never;

describe("classificação bot→bot", () => {
	it("pedido de outro bot (origin bot) vira fala de bot, sem a moldura", () => {
		const item = sessionMessageToItem(row({ origin: "bot", fromBotId: "b-grok", fromBotName: "Grok Bot", botMessageId: "bm-1", content: "Mensagem do bot Grok Bot:\nOlá, Cookie" }));
		expect(item).toMatchObject({ kind: "user", text: "Olá, Cookie", bot: { kind: "request", fromBotId: "b-grok", fromBotName: "Grok Bot", botMessageId: "bm-1" } });
		expect(isBotSpeech(item!)).toBe(true);
	});
	it("resposta recebida (moldura 'Resposta do bot') e fala do bot ao atender (assistant + origin bot)", () => {
		expect(sessionMessageToItem(row({ origin: "bot", fromBotName: "Grok Bot", content: "Resposta do bot Grok Bot:\nfeito" }))).toMatchObject({ kind: "user", text: "feito", bot: { kind: "reply" } });
		expect(sessionMessageToItem(row({ role: "assistant", origin: "bot", botMessageId: "bm-1", content: "Oi!" }))).toMatchObject({ kind: "assistant", text: "Oi!", bot: { kind: "answer", botMessageId: "bm-1" } });
	});
	it("fala normal do usuário e do bot não ganha marca de bot", () => {
		expect(sessionMessageToItem(row({ content: "bom dia" }))).not.toHaveProperty("bot");
		expect(sessionMessageToItem(row({ role: "assistant", content: "bom dia!" }))).not.toHaveProperty("bot");
		expect(sessionMessageToItem(row({ origin: "routine", content: "bom dia" }))).not.toHaveProperty("bot");
	});
	it("pedido sem moldura ainda é classificado como pedido de bot", () => {
		expect(sessionMessageToItem(row({ origin: "bot", fromBotName: "Grok Bot", content: "sem moldura" }))).toMatchObject({ text: "sem moldura", bot: { kind: "request" } });
	});
});

describe("agrupamento no marcador", () => {
	it("pedido + resposta do bot + mais duas falas viram uma linha com a contagem certa", () => {
		const out = groupBotItems([user("u1"), request("r1"), answer("a1"), request("r2", "bm-2"), answer("a2", "bm-2"), bot("b1")]);
		expect(out.map((item) => item.kind)).toEqual(["user", "bot-exchange", "assistant"]);
		expect(out[1]).toMatchObject({ id: "bot-exchange:r1", direction: "group", count: 4, partners: [{ id: "b-grok", name: "Grok Bot" }], focus: "bm-r1:req", createdAt: "2026-11-03T10:00:00.000Z" });
		expect(botExchangeLabel(out[1] as never)).toBe("4 mensagens com Grok Bot");
		expect(exchangePeerId(out[1] as never)).toBe("b-grok");
	});
	it("não engole mensagens do usuário: fala dele no meio fecha o trecho", () => {
		const out = groupBotItems([request("r1"), answer("a1"), user("u1", "e aí?"), bot("b1", "tudo certo"), request("r2", "bm-2")]);
		expect(out.map((item) => item.kind)).toEqual(["bot-exchange", "user", "assistant", "bot-exchange"]);
		expect(out.filter((item) => item.kind === "bot-exchange").map((item) => (item as { count: number }).count)).toEqual([2, 1]);
		expect(out[1]).toMatchObject({ id: "u1", text: "e aí?" });
		expect(botExchangeLabel(out[3] as never)).toBe("1 mensagem com Grok Bot");
	});
	it("só respostas recebidas viram 'Mensagem de X' (uma por resposta)", () => {
		const out = groupBotItems([reply("p1"), reply("p2")]);
		expect(out).toHaveLength(2);
		expect(botExchangeLabel(out[0] as never)).toBe("Mensagem de Grok Bot");
		expect(out[0]).toMatchObject({ direction: "received", focus: "bm-r:reply" });
	});
	it("trecho com bots misturados vira um marcador por parceiro; a fala do bot fica com o parceiro do pedido anterior", () => {
		const ana: ChatItem = { id: "r3", kind: "user", text: "ei", bot: { kind: "request", fromBotId: "b-ana", fromBotName: "Ana", botMessageId: "bm-3" } };
		const out = groupBotItems([request("r1"), answer("a1"), ana, answer("a3", "bm-3")]);
		expect(out.map((item) => item.kind)).toEqual(["bot-exchange", "bot-exchange"]);
		expect(botExchangeLabel(out[0] as never)).toBe("2 mensagens com Grok Bot");
		expect(botExchangeLabel(out[1] as never)).toBe("2 mensagens com Ana");
		expect(exchangePeerId(out[1] as never)).toBe("b-ana");
		expect(out[1]).toMatchObject({ id: "bot-exchange:r3", focus: "bm-3:req" });
	});
	it("fala sem nome, sozinha, é 'outro bot' e não abre", () => {
		const anon = groupBotItems([answer("a1")])[0] as never;
		expect(botExchangeLabel(anon)).toBe("1 mensagem com outro bot");
		expect(exchangePeerId(anon)).toBeNull();
	});
	it("o usuário digitar 'Mensagem do bot Ana:' não vira marcador: o balão aparece normal", () => {
		const typed = user("u1", "Mensagem do bot Ana:\nvalor 10");
		expect(groupBotItems([typed])).toEqual([typed]);
		expect(isBotSpeech(typed)).toBe(false);
	});
	it("a identidade é a da primeira fala: a mesma ao vivo e restaurada, mesmo com mais falas depois", () => {
		const first = groupBotItems([request("r1"), answer("a1")])[0]!;
		const later = groupBotItems([user("u0"), request("r1"), answer("a1"), request("r2", "bm-2")])[1]!;
		expect(later.id).toBe(first.id);
	});
	it("lista sem fala de bot passa intacta", () => {
		const items = [user("u1"), bot("b1")];
		expect(groupBotItems(items)).toEqual(items);
	});
});

describe("data e hora acima da linha", () => {
	const now = Date.parse("2026-11-03T15:00:00.000Z");
	it("hoje, ontem e outro dia", () => {
		expect(exchangeStamp("2026-11-03T13:05:00.000Z", now, "UTC")).toBe("Hoje 13:05");
		expect(exchangeStamp("2026-11-02T09:30:00.000Z", now, "UTC")).toBe("Ontem 09:30");
		expect(exchangeStamp("2026-10-20T09:30:00.000Z", now, "UTC")).toBe("20/10 09:30");
		expect(exchangeStamp(undefined, now, "UTC")).toBe("");
		expect(exchangeStamp("lixo", now, "UTC")).toBe("");
	});
});

describe("cache", () => {
	it("a marca de bot sobrevive ao disco e agrupa igual ao vivo", () => {
		const items = [user("u1"), request("r1"), answer("a1")];
		const restored = parseChat(serializeChat(items, NOW), NOW)!.items;
		expect(restored[1]).toMatchObject({ bot: { kind: "request", fromBotId: "b-grok", botMessageId: "bm-r1" } });
		expect(groupBotItems(restored)).toEqual(groupBotItems(items));
	});
	it("cache da versão anterior (sem `bot`) é descartado, em vez de adivinhar pelo texto", () => {
		const raw = JSON.stringify({ v: 1, savedAt: NOW, items: [{ id: "r1", kind: "user", text: "Mensagem do bot Bobinho:\nOlá" }] });
		expect(parseChat(raw, NOW)).toBeNull();
	});
	it("marca de bot inválida no disco é ignorada, sem quebrar a fala", () => {
		const raw = JSON.stringify({ v: 3, savedAt: NOW, items: [{ id: "u1", kind: "user", text: "oi", bot: { kind: "x" } }] });
		expect(parseChat(raw, NOW)!.items).toEqual([{ id: "u1", kind: "user", text: "oi" }]);
	});
});
