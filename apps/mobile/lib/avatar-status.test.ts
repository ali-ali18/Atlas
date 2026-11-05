import { describe, expect, it } from "vitest";
import { avatarDotSize, lastMessageNeedsYou, resolveAvatarStatus } from "./avatar-status";
import { toHomeBot } from "./home-list";
import type { Bot } from "@workspace/shared";

describe("resolveAvatarStatus", () => {
	it("trabalhando > precisa de você > não lida > nada", () => {
		expect(resolveAvatarStatus({ working: true, needsYou: true, unread: true })).toBe("working");
		expect(resolveAvatarStatus({ needsYou: true, unread: true })).toBe("needs");
		expect(resolveAvatarStatus({ unread: true })).toBe("unread");
		expect(resolveAvatarStatus({})).toBe("none");
	});
});

describe("avatarDotSize", () => {
	it("26% do avatar, entre 10 e 16 (igual ao web)", () => {
		expect(avatarDotSize(20)).toBe(10);
		expect(avatarDotSize(48)).toBe(12);
		expect(avatarDotSize(86)).toBe(16);
		expect(avatarDotSize(400)).toBe(16);
	});
});

describe("lastMessageNeedsYou", () => {
	const card = (kind: string, status: string) => JSON.stringify({ v: 1, kind, title: "Pagar?", status });
	it("card pendente de login, aprovação, questionário ou perfil acende", () => {
		expect(lastMessageNeedsYou({ role: "confirm", content: card("confirm", "pending") })).toBe(true);
		expect(lastMessageNeedsYou({ role: "login", content: card("login", "pending") })).toBe(true);
		expect(lastMessageNeedsYou({ role: "questionnaire", content: card("questionnaire", "pending") })).toBe(true);
	});
	it("card já resolvido não acende", () => {
		expect(lastMessageNeedsYou({ role: "confirm", content: card("confirm", "approved") })).toBe(false);
		expect(lastMessageNeedsYou({ role: "login", content: card("login", "done") })).toBe(false);
	});
	it("status cortado pela prévia de 200 caracteres = não sabe = não acende", () => {
		const long = JSON.stringify({ v: 1, kind: "questionnaire", title: "x".repeat(300), status: "pending" }).slice(0, 200);
		expect(lastMessageNeedsYou({ role: "questionnaire", content: long })).toBe(false);
	});
	it("texto, outros cards e sem mensagem não acendem", () => {
		expect(lastMessageNeedsYou({ role: "assistant", content: "status: pending" })).toBe(false);
		expect(lastMessageNeedsYou({ role: "routine", content: card("routine", "pending") })).toBe(false);
		expect(lastMessageNeedsYou(null)).toBe(false);
	});
});

describe("toHomeBot: working e needsYou", () => {
	const base = { id: "a", name: "A", color: "#fff", shape: "blob", memberIds: [], isPrimary: false, lastMessage: null } as unknown as Bot;
	it("working vem do servidor; sem o campo é falso", () => {
		expect(toHomeBot({ ...base, working: true }).working).toBe(true);
		expect(toHomeBot(base).working).toBe(false);
	});
	it("needsYou sai do card pendente da última mensagem", () => {
		const last = { role: "confirm", content: '{"v":1,"kind":"confirm","title":"ok","status":"pending"}', createdAt: "2026-01-01T00:00:00Z" };
		expect(toHomeBot({ ...base, lastMessage: last }).needsYou).toBe(true);
		expect(toHomeBot(base).needsYou).toBe(false);
	});
});
