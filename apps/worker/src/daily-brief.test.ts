import assert from "node:assert/strict";
import { test } from "node:test";
import { deliverDailyBrief, isDetachedBriefRun, type BriefDeliveryDeps } from "./daily-brief.js";
import { runsDetachedFromChat } from "./processors/routine-defer.js";

function deps(overrides: Partial<BriefDeliveryDeps> = {}) {
	const calls = { appended: [] as Array<[string, string]>, pushed: [] as Array<[string, string, string]> };
	const base: BriefDeliveryDeps = {
		conversationOf: async (botId, userId) => (botId === "bot-a" && userId === "user-a" ? "conv-a" : null),
		hasActiveRun: async () => false,
		appendMessage: async (conversationId, text) => void calls.appended.push([conversationId, text]),
		push: async (userId, conversationId, text) => void calls.pushed.push([userId, conversationId, text]),
	};
	return { calls, deps: { ...base, ...overrides } };
}

const input = { userId: "user-a", botId: "bot-a", text: "Seu dia está pronto: 3 reuniões, 2 e-mails pedem resposta", notify: "always" as const };

test("brief pronto, conversa livre: o push sai e a frase entra no chat", async () => {
	const { calls, deps: d } = deps();
	assert.deepEqual(await deliverDailyBrief(input, d), { posted: true, pushed: true });
	assert.deepEqual(calls.pushed, [["user-a", "conv-a", input.text]]);
	assert.deepEqual(calls.appended, [["conv-a", input.text]]);
});

test("tarefa rodando na conversa: o push sai na hora, mas a frase NÃO entra no chat (sem atropelar)", async () => {
	const { calls, deps: d } = deps({ hasActiveRun: async () => true });
	const result = await deliverDailyBrief(input, d);
	assert.equal(result.posted, false);
	assert.equal(result.pushed, true);
	assert.equal(calls.appended.length, 0);
	assert.equal(calls.pushed.length, 1);
});

test("rotina com aviso 'só importante' não manda push (a frase ainda entra no chat)", async () => {
	const { calls, deps: d } = deps();
	const result = await deliverDailyBrief({ ...input, notify: "important" }, d);
	assert.deepEqual(result, { posted: true, pushed: false });
	assert.equal(calls.pushed.length, 0);
});

test("falha do push não impede a mensagem; sem chave de push também segue", async () => {
	const failing = deps({ push: async () => { throw new Error("vapid"); } });
	assert.deepEqual(await deliverDailyBrief(input, failing.deps), { posted: true, pushed: false });
	const noPush = deps({ push: undefined });
	assert.deepEqual(await deliverDailyBrief(input, noPush.deps), { posted: true, pushed: false });
});

test("sem texto, sem bot ou bot de outro dono: não entrega nada", async () => {
	const { calls, deps: d } = deps();
	assert.equal((await deliverDailyBrief({ ...input, text: "  " }, d)).posted, false);
	assert.equal((await deliverDailyBrief({ ...input, botId: null }, d)).posted, false);
	// a conversa vem escopada pelo dono: o mesmo bot pedido por outro usuário não resolve conversa
	assert.deepEqual(await deliverDailyBrief({ ...input, userId: "user-b" }, d), { posted: false, pushed: false, reason: "bot sem conversa" });
	assert.equal(calls.appended.length + calls.pushed.length, 0);
});

test("isDetachedBriefRun: só o run de rotina sem conversa da rotina 'Seu dia'", () => {
	assert.equal(isDetachedBriefRun({ origin: "routine", conversationId: null }, "daily_brief"), true);
	assert.equal(isDetachedBriefRun({ origin: "routine", conversationId: "c" }, "daily_brief"), false);
	assert.equal(isDetachedBriefRun({ origin: "routine", conversationId: null }, null), false);
	assert.equal(isDetachedBriefRun({ origin: "chat", conversationId: null }, "daily_brief"), false);
	assert.equal(isDetachedBriefRun({ origin: "proactive", conversationId: null }, "daily_brief"), false);
});

test("runsDetachedFromChat: só o modelo daily_brief", () => {
	assert.equal(runsDetachedFromChat("daily_brief"), true);
	assert.equal(runsDetachedFromChat("github_security_review"), false);
	assert.equal(runsDetachedFromChat(null), false);
	assert.equal(runsDetachedFromChat(undefined), false);
});
