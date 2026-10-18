import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@/components/ui/templates/template-4/data";
import { isAwaitingBot, mergeNeedsUserMarkers, pendingNeedsUser } from "./bot-needs-thread";

const need = { type: "login" as const, label: "Fazer login em x.com", cardId: "c1", conversationId: "cv" };
const sent = (createdAt: string): Message => ({ id: "s1", kind: "bot-link", botId: "b", botName: "Bobinho", title: "t", botMessageId: "m1", createdAt });
const marker = (status: "pending" | "resolved", createdAt = "2026-01-01T10:00:02.000Z"): Message => ({
	id: "n1",
	kind: "needs-user",
	botId: "b",
	botName: "Bobinho",
	title: "t",
	botMessageId: "m1",
	need,
	status,
	createdAt,
});

test("aguardando: marcador de envio sem resposta; resposta do bot encerra", () => {
	const now = Date.parse("2026-01-01T10:05:00.000Z");
	assert.equal(isAwaitingBot([sent("2026-01-01T10:00:00.000Z")], now), true);
	assert.equal(isAwaitingBot([sent("2026-01-01T10:00:00.000Z"), { id: "u", kind: "user", text: "r", bot: { kind: "reply" } }], now), false);
	assert.equal(isAwaitingBot([sent("2026-01-01T10:00:00.000Z")], Date.parse("2026-01-02T10:00:00.000Z")), false);
	assert.equal(isAwaitingBot([{ id: "a", kind: "assistant", text: "oi" }], now), false);
});

test("mesclar: insere o marcador novo na ordem do tempo e atualiza o estado no lugar", () => {
	const previous: Message[] = [sent("2026-01-01T10:00:00.000Z"), { id: "a", kind: "assistant", text: "Pedi ao Bobinho", createdAt: "2026-01-01T10:00:05.000Z" }];
	const inserted = mergeNeedsUserMarkers(previous, [marker("pending")]);
	assert.deepEqual(inserted.map((m) => m.id), ["s1", "n1", "a"]);
	assert.equal(pendingNeedsUser(inserted).length, 1);
	assert.equal(mergeNeedsUserMarkers(inserted, [marker("pending")]), inserted);
	const resolved = mergeNeedsUserMarkers(inserted, [marker("resolved")]);
	assert.equal(pendingNeedsUser(resolved).length, 0);
	assert.equal(resolved.length, 3);
});
