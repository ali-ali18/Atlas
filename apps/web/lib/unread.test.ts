import assert from "node:assert/strict";
import { test } from "node:test";
import {
	agentUnreadPatch,
	botHasUnread,
	messageBefore,
	newMessagesSince,
	previewWithSource,
	MARK_READ_MAX_RESENDS,
	MARK_READ_RESEND_MS,
	shouldMarkRead,
	sourceMarkerIds,
	stripUnreadTitle,
	totalUnread,
	withUnreadTitle,
} from "./unread";

const src = (label: string, at = "2026-10-30T23:00:00.000Z") => ({ kind: "routine" as const, label, at });

test("bolinha: contagem do servidor, marca manual ou resultado antigo", () => {
	assert.equal(botHasUnread({ unreadCount: 2 }), true);
	assert.equal(botHasUnread({ unreadCount: 0, manualUnread: true }), true);
	assert.equal(botHasUnread({ unreadCount: 0, manualUnread: false }), false);
	assert.equal(botHasUnread({ unreadResults: 1 }), true);
	assert.equal(botHasUnread({}), false);
});

test("título da aba: (N) com o total, sem acumular prefixo", () => {
	assert.equal(totalUnread([{ unreadCount: 2 }, { unreadCount: 0, manualUnread: true }, { unreadCount: 0 }, {}]), 3);
	assert.equal(withUnreadTitle("Conversas", 3), "(3) Conversas");
	assert.equal(withUnreadTitle("(3) Conversas", 5), "(5) Conversas");
	assert.equal(withUnreadTitle("(5) Conversas", 0), "Conversas");
	assert.equal(stripUnreadTitle("(abc) x"), "(abc) x");
});

test("divisor e pílula: contagem desde a última mensagem vista", () => {
	const messages = [
		{ id: "1", kind: "assistant" },
		{ id: "2", kind: "user" },
		{ id: "3", kind: "assistant" },
		{ id: "4", kind: "assistant" },
	];
	assert.equal(messageBefore(messages, "3"), "2");
	assert.equal(messageBefore(messages, "1"), null);
	assert.equal(messageBefore(messages, null), "4");
	assert.equal(newMessagesSince(messages, "2"), 2);
	assert.equal(newMessagesSince(messages, "4"), 0);
	assert.equal(newMessagesSince(messages, null), 3);
});

test("só marca como lida com a última mensagem à vista, aba visível e em foco", () => {
	const base = { bottomVisible: true, documentVisible: true, focused: true, lastMessageId: "m9", lastSentId: null, pending: true };
	assert.equal(shouldMarkRead(base), true);
	assert.equal(shouldMarkRead({ ...base, bottomVisible: false }), false);
	assert.equal(shouldMarkRead({ ...base, documentVisible: false }), false);
	assert.equal(shouldMarkRead({ ...base, focused: false }), false);
	assert.equal(shouldMarkRead({ ...base, lastSentId: "m9" }), false);
	assert.equal(shouldMarkRead({ ...base, pending: false }), false);
});

test("marcador só no início de cada trecho de mesma origem", () => {
	const ids = sourceMarkerIds([
		{ id: "a", runSource: src("Agenda") },
		{ id: "b", runSource: src("Agenda") },
		{ id: "c" },
		{ id: "d", runSource: src("Agenda") },
		{ id: "e", runSource: src("Agenda", "2026-10-31T23:00:00.000Z") },
	]);
	assert.deepEqual([...ids], ["a", "d", "e"]);
});

test("prévia da lista e patch do servidor", () => {
	assert.equal(previewWithSource("Hoje: 3 reuniões", { kind: "routine", label: "Resumo da agenda" }), "Rotina: Resumo da agenda · Hoje: 3 reuniões");
	assert.equal(previewWithSource("oi", null), "oi");
	const patch = agentUnreadPatch({ unreadCount: 3, firstUnreadMessageId: "x", manualUnread: false, lastMessage: { role: "assistant", content: "ok", createdAt: "", source: { kind: "reminder", label: "Pagar luz" } } } as never);
	assert.deepEqual([patch.notifications, patch.unreadCount, patch.lastMessage], [true, 3, "Lembrete: Pagar luz · ok"]);
});

test("corrida: mesmo id só é reenviado se o servidor ainda diz não lida, com espaçamento e limite", () => {
	const base = { bottomVisible: true, documentVisible: true, focused: true, lastMessageId: "m9", lastSentId: "m9", pending: false, lastSentAt: 1000 };
	assert.equal(shouldMarkRead({ ...base, serverUnread: false, now: 99_999 }), false);
	assert.equal(shouldMarkRead({ ...base, serverUnread: true, now: 1500 }), false);
	assert.equal(shouldMarkRead({ ...base, serverUnread: true, now: 1000 + MARK_READ_RESEND_MS }), true);
	assert.equal(shouldMarkRead({ ...base, serverUnread: true, now: 99_999, resends: MARK_READ_MAX_RESENDS }), false);
	assert.equal(shouldMarkRead({ ...base, serverUnread: true, now: 99_999, bottomVisible: false }), false);
});

test("mensagem nova marca mesmo sem bolinha, se o servidor já aponta não lida", () => {
	const base = { bottomVisible: true, documentVisible: true, focused: true, lastMessageId: "m10", lastSentId: "m9", pending: false };
	assert.equal(shouldMarkRead(base), false);
	assert.equal(shouldMarkRead({ ...base, serverUnread: true }), true);
});
