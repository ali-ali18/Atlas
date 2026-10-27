import assert from "node:assert/strict";
import { test } from "node:test";
import { briefPushBody, deliverDailyBrief, flushPendingBriefs, isDetachedBriefRun, type BriefDeliveryDeps } from "./daily-brief.js";
import { runsDetachedFromChat } from "./processors/routine-defer.js";

/** Armazém em memória do estado pendente/postado, com a mesma semântica atômica do banco. */
function fixture(overrides: Partial<BriefDeliveryDeps> = {}) {
	const state = new Map<string, { state: "pending" | "posted"; text: string; botId: string; userId: string }>();
	const calls = { appended: [] as Array<[string, string]>, pushed: [] as Array<[string, string, string]> };
	let busy = false;
	const base: BriefDeliveryDeps = {
		conversationOf: async (botId, userId) => (botId === "bot-a" && userId === "user-a" ? "conv-a" : null),
		hasActiveRun: async () => busy,
		appendMessage: async (conversationId, text) => void calls.appended.push([conversationId, text]),
		push: async (userId, conversationId, text) => void calls.pushed.push([userId, conversationId, text]),
		markPending: async (id, text) => {
			if (state.get(id)?.state !== "posted") state.set(id, { state: "pending", text, botId: "bot-a", userId: "user-a" });
		},
		claim: async (id) => {
			const row = state.get(id);
			if (row?.state !== "pending") return false;
			row.state = "posted";
			return true;
		},
		release: async (id) => {
			const row = state.get(id);
			if (row) row.state = "pending";
		},
	};
	const deps = { ...base, ...overrides };
	const flush = () =>
		flushPendingBriefs({
			...deps,
			listPending: async () => [...state.entries()].filter(([, row]) => row.state === "pending").map(([routineRunId, row]) => ({ routineRunId, userId: row.userId, botId: row.botId, text: row.text })),
		});
	return { calls, deps, state, flush, setBusy: (value: boolean) => void (busy = value) };
}

const TEXT = "Hoje você tem uma aula e um prazo.\n\n- 10h: aula de Estatística\n- Prazo às 23h59: trabalho de História";
const input = { routineRunId: "rr-1", userId: "user-a", botId: "bot-a", text: TEXT, notify: "always" as const };

test("conversa livre: o brief entra no chat na hora e o push leva a primeira linha", async () => {
	const { calls, deps, state } = fixture();
	assert.deepEqual(await deliverDailyBrief(input, deps), { posted: true, pushed: true });
	assert.deepEqual(calls.appended, [["conv-a", TEXT]]);
	assert.deepEqual(calls.pushed, [["user-a", "conv-a", "Hoje você tem uma aula e um prazo."]]);
	assert.equal(state.get("rr-1")?.state, "posted");
});

test("conversa ocupada: o push sai na hora, o brief fica pendente e entra depois que a tarefa termina", async () => {
	const f = fixture();
	f.setBusy(true);
	const result = await deliverDailyBrief(input, f.deps);
	assert.equal(result.posted, false);
	assert.equal(result.pushed, true);
	assert.equal(f.calls.pushed.length, 1);
	assert.equal(f.calls.appended.length, 0);
	assert.equal(f.state.get("rr-1")?.state, "pending");
	// ainda ocupada: a varredura não posta
	assert.equal(await f.flush(), 0);
	assert.equal(f.calls.appended.length, 0);
	// a tarefa terminou: entra uma vez
	f.setBusy(false);
	assert.equal(await f.flush(), 1);
	assert.deepEqual(f.calls.appended, [["conv-a", TEXT]]);
	assert.equal(f.calls.pushed.length, 1, "o push não se repete");
});

test("catch-up da varredura: brief pendente (worker caiu antes de postar) entra uma vez, sem duplicar", async () => {
	const f = fixture();
	f.state.set("rr-9", { state: "pending", text: "Resumo", botId: "bot-a", userId: "user-a" });
	assert.equal(await f.flush(), 1);
	assert.equal(await f.flush(), 0);
	assert.deepEqual(f.calls.appended, [["conv-a", "Resumo"]]);
});

test("sem duplicar: fim de run e varredura disputando o mesmo brief postam uma vez só", async () => {
	const f = fixture();
	f.setBusy(true);
	await deliverDailyBrief(input, f.deps);
	f.setBusy(false);
	const results = await Promise.all([f.flush(), f.flush(), f.flush()]);
	assert.equal(results.reduce((a, b) => a + b, 0), 1);
	assert.equal(f.calls.appended.length, 1);
});

test("gravação da mensagem falhou: volta a pendente e a próxima varredura entrega", async () => {
	let fail = true;
	const f = fixture({
		appendMessage: async (conversationId, text) => {
			if (fail) throw new Error("db fora");
			f.calls.appended.push([conversationId, text]);
		},
	});
	assert.equal((await deliverDailyBrief(input, f.deps)).posted, false);
	assert.equal(f.state.get("rr-1")?.state, "pending");
	fail = false;
	assert.equal(await f.flush(), 1);
	assert.equal(f.calls.appended.length, 1);
});

test("rotina com aviso 'só importante' não manda push (o brief ainda entra no chat)", async () => {
	const { calls, deps } = fixture();
	assert.deepEqual(await deliverDailyBrief({ ...input, notify: "important" }, deps), { posted: true, pushed: false });
	assert.equal(calls.pushed.length, 0);
});

test("falha do push não impede a mensagem; sem chave de push também segue", async () => {
	const failing = fixture({ push: async () => { throw new Error("vapid"); } });
	assert.deepEqual(await deliverDailyBrief(input, failing.deps), { posted: true, pushed: false });
	const noPush = fixture({ push: undefined });
	assert.deepEqual(await deliverDailyBrief(input, noPush.deps), { posted: true, pushed: false });
});

test("sem texto, sem bot, sem execução ou bot de outro dono: não entrega nem guarda nada", async () => {
	const { calls, deps, state } = fixture();
	assert.equal((await deliverDailyBrief({ ...input, text: "  " }, deps)).posted, false);
	assert.equal((await deliverDailyBrief({ ...input, botId: null }, deps)).posted, false);
	assert.equal((await deliverDailyBrief({ ...input, routineRunId: null }, deps)).posted, false);
	// a conversa vem escopada pelo dono: o mesmo bot pedido por outro usuário não resolve conversa
	assert.deepEqual(await deliverDailyBrief({ ...input, userId: "user-b" }, deps), { posted: false, pushed: false, reason: "bot sem conversa" });
	assert.equal(calls.appended.length + calls.pushed.length + state.size, 0);
});

test("a varredura respeita o dono: bot de outro usuário não resolve conversa e nada é postado", async () => {
	const f = fixture();
	f.state.set("rr-x", { state: "pending", text: "Resumo", botId: "bot-a", userId: "user-b" });
	assert.equal(await f.flush(), 0);
	assert.equal(f.calls.appended.length, 0);
});

test("briefPushBody: primeira linha não vazia, com limite", () => {
	assert.equal(briefPushBody("\n  Primeira linha  \nsegunda"), "Primeira linha");
	assert.ok(briefPushBody("x".repeat(500)).length <= 180);
});

test("isDetachedBriefRun: run de rotina sem conversa é brief (falha fechada, sem depender do banco)", () => {
	assert.equal(isDetachedBriefRun({ origin: "routine", conversationId: null }), true);
	assert.equal(isDetachedBriefRun({ origin: "routine" }), true);
	assert.equal(isDetachedBriefRun({ origin: "routine", conversationId: "c" }), false);
	assert.equal(isDetachedBriefRun({ origin: "chat", conversationId: null }), false);
	assert.equal(isDetachedBriefRun({ origin: "proactive", conversationId: null }), false);
});

test("runsDetachedFromChat: só o modelo daily_brief", () => {
	assert.equal(runsDetachedFromChat("daily_brief"), true);
	assert.equal(runsDetachedFromChat("github_security_review"), false);
	assert.equal(runsDetachedFromChat(null), false);
	assert.equal(runsDetachedFromChat(undefined), false);
});
