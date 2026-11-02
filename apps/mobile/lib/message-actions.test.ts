import { BOT_REACTION_EMOJIS, normalizeReactionEmoji } from "@workspace/shared";
import { describe, expect, it } from "vitest";
import type { ChatItem } from "./chat-types";
import { isStoredMessage, messageMenuFor, myReaction, REACTION_ROWS, toggleUserReaction } from "./message-actions";

describe("REACTION_ROWS", () => {
	it("tem duas fileiras (6 + 5), sem repetição, e o servidor aceita todas", () => {
		expect(REACTION_ROWS.map((row) => row.length)).toEqual([6, 5]);
		const all = REACTION_ROWS.flat();
		expect(new Set(all).size).toBe(all.length);
		for (const emoji of all) expect(normalizeReactionEmoji(emoji)).toBe(emoji);
	});
	it("inclui as reações que o bot usa", () => {
		for (const emoji of BOT_REACTION_EMOJIS) expect(REACTION_ROWS.flat()).toContain(emoji);
	});
});

describe("toggleUserReaction", () => {
	it("sem reação: adiciona", () => {
		expect(toggleUserReaction(undefined, "👍")).toEqual([{ actor: "user", emoji: "👍" }]);
	});
	it("outra reação do usuário: troca, e a do bot fica", () => {
		const before = [
			{ actor: "bot" as const, emoji: "❤️" },
			{ actor: "user" as const, emoji: "👍" },
		];
		expect(toggleUserReaction(before, "😂")).toEqual([
			{ actor: "bot", emoji: "❤️" },
			{ actor: "user", emoji: "😂" },
		]);
	});
	it("a mesma: remove (e devolve undefined se não sobra nada)", () => {
		expect(toggleUserReaction([{ actor: "user", emoji: "👍" }], "👍")).toBeUndefined();
		expect(
			toggleUserReaction(
				[
					{ actor: "bot", emoji: "❤️" },
					{ actor: "user", emoji: "👍" },
				],
				"👍",
			),
		).toEqual([{ actor: "bot", emoji: "❤️" }]);
	});
	it("não muda a lista recebida", () => {
		const before = [{ actor: "user" as const, emoji: "👍" }];
		toggleUserReaction(before, "🔥");
		expect(before).toEqual([{ actor: "user", emoji: "👍" }]);
	});
});

describe("myReaction", () => {
	it("só olha a do usuário", () => {
		expect(myReaction([{ actor: "bot", emoji: "❤️" }])).toBeNull();
		expect(
			myReaction([
				{ actor: "bot", emoji: "❤️" },
				{ actor: "user", emoji: "🙏" },
			]),
		).toBe("🙏");
		expect(myReaction(undefined)).toBeNull();
	});
});

describe("messageMenuFor", () => {
	it("bot com run: oferece o id da solicitação e a reação atual", () => {
		const item: ChatItem = { id: "m2", kind: "assistant", text: "Pronto.", runId: "run-1", reactions: [{ actor: "user", emoji: "🔥" }] };
		expect(messageMenuFor(item)).toEqual({ text: "Pronto.", runId: "run-1", reaction: "🔥" });
	});
	it("bot sem run: sem id da solicitação", () => {
		expect(messageMenuFor({ id: "m2", kind: "assistant", text: "Oi" })).toEqual({ text: "Oi", runId: null, reaction: null });
	});
	it("usuário: nunca tem id da solicitação", () => {
		expect(messageMenuFor({ id: "m1", kind: "user", text: "Oi" })).toEqual({ text: "Oi", runId: null, reaction: null });
	});
	it("balão otimista, fala ao vivo, cartão, marcador e texto vazio não abrem", () => {
		expect(messageMenuFor({ id: "msg-1-abc", kind: "user", text: "Oi" })).toBeNull();
		expect(messageMenuFor({ id: "cu-s1", kind: "assistant", text: "Olá" })).toBeNull();
		expect(messageMenuFor({ id: "cu-run-error", kind: "assistant", text: "Erro" })).toBeNull();
		expect(messageMenuFor({ id: "k", kind: "marker", text: "x" })).toBeNull();
		expect(messageMenuFor({ id: "m3", kind: "assistant", text: "   " })).toBeNull();
	});
	it("isStoredMessage aceita só falas gravadas", () => {
		expect(isStoredMessage({ id: "m1", kind: "user", text: "Oi" })).toBe(true);
		expect(isStoredMessage({ id: "msg-1", kind: "user", text: "Oi" })).toBe(false);
	});
});
