import { describe, expect, it } from "vitest";
import { shouldMarkSeen } from "./read-state";

describe("shouldMarkSeen", () => {
	it("abre uma conversa não lida: marca com o id da última mensagem", () => {
		expect(shouldMarkSeen({ unread: true, lastId: "m2", lastSentId: null, baselineId: null })).toBe(true);
	});
	it("abre uma conversa já lida: não chama o servidor à toa", () => {
		expect(shouldMarkSeen({ unread: false, lastId: "m2", lastSentId: null, baselineId: null })).toBe(false);
	});
	it("mensagem nova com a conversa aberta marca de novo", () => {
		expect(shouldMarkSeen({ unread: false, lastId: "m3", lastSentId: "m2", baselineId: "m2" })).toBe(true);
	});
	it("não reenvia o mesmo id", () => {
		expect(shouldMarkSeen({ unread: true, lastId: "m2", lastSentId: "m2", baselineId: "m2" })).toBe(false);
	});
	it("conversa vazia não marca", () => {
		expect(shouldMarkSeen({ unread: true, lastId: null, lastSentId: null, baselineId: null })).toBe(false);
	});
});
