/** "Já pedi login neste site" vale por conversa (30 min), não só por run; e é escopado ao dono. */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { serializeConversationCard } from "@workspace/shared";
import { FakeTable, installFakes } from "./testing/fake-tables.js";
import { listRecentLoginAskSites } from "./login-asks.js";

const NOW = new Date("2026-10-27T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const loginCard = (site: string, extra: Record<string, unknown> = {}) =>
	serializeConversationCard({ v: 1, kind: "login", loginId: `l-${site}`, site, url: `https://${site}/login`, status: "done", ...extra } as never);

let installed: { restore: () => void };

beforeEach(() => {
	installed = installFakes({
		conversation: new FakeTable([
			{ id: "conv-a", userId: "user-a" },
			{ id: "conv-b", userId: "user-b" },
		]),
		conversationMessage: new FakeTable([
			{ id: "m1", conversationId: "conv-a", role: "login", createdAt: minutesAgo(10), content: loginCard("painel.exemplo.com") },
			{ id: "m2", conversationId: "conv-a", role: "login", createdAt: minutesAgo(45), content: loginCard("velho.example.com") },
			{ id: "m3", conversationId: "conv-a", role: "login", createdAt: minutesAgo(5), content: loginCard("captcha.example.com", { reason: "captcha" }) },
			{ id: "m4", conversationId: "conv-b", role: "login", createdAt: minutesAgo(1), content: loginCard("outro.example.com") },
			{ id: "m5", conversationId: "conv-a", role: "assistant", createdAt: minutesAgo(2), content: "oi" },
		]),
	});
});
afterEach(() => installed.restore());

test("devolve só os sites com card de login nos últimos 30 min (sem captcha, sem outras mensagens)", async () => {
	assert.deepEqual(await listRecentLoginAskSites("user-a", "conv-a", NOW), ["painel.exemplo.com"]);
});

test("usuário B não enxerga os cards da conversa do usuário A", async () => {
	assert.deepEqual(await listRecentLoginAskSites("user-b", "conv-a", NOW), []);
	assert.deepEqual(await listRecentLoginAskSites("user-a", "conv-b", NOW), []);
	assert.deepEqual(await listRecentLoginAskSites("default", "conv-a", NOW), []);
});
