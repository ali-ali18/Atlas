import assert from "node:assert/strict";
import { test } from "node:test";
import { foldAutomatedMessages, type RoutineAlert } from "@workspace/shared";
import { planAlertRun, settleAlertRun } from "./routine-alert.js";
import { notifyRoutineRunFailure } from "./routine-run-failure.js";

const NOW = new Date("2026-10-02T12:00:00.000Z");
const idle: RoutineAlert = { condition: "o estoque de canela cair abaixo de 10", active: false };
const yes = { triggered: true, summary: "Estoque da canela: 7 un. (mínimo 10)" };
const no = { triggered: false, summary: "Estoque da canela: 25 un." };

function plan(alert: RoutineAlert, verdict: typeof yes | null, modelText?: string) {
	return planAlertRun({ alert, routineName: "Estoque da canela", verdict, modelText, now: NOW });
}

function fakeDeps(over: { record?: () => Promise<boolean>; push?: boolean } = {}) {
	const calls = { records: [] as Array<{ userId: string; routineId: string; next: RoutineAlert }>, pushes: [] as Array<{ userId: string; conversationId: string; text: string }>, logs: [] as string[] };
	const deps = {
		record: over.record ?? (async (userId: string, routineId: string, next: RoutineAlert, _every?: number) => {
			calls.records.push({ userId, routineId, next });
			return true;
		}),
		push: over.push === false ? undefined : async (userId: string, conversationId: string, text: string) => void calls.pushes.push({ userId, conversationId, text }),
		log: (line: string) => void calls.logs.push(line),
	};
	return { deps, calls };
}
const target = { userId: "user-a", routineId: "r1", conversationId: "conv-a" };

test("condição verdadeira pela primeira vez: avisa com ⚠️ e resumo, e grava 'em alerta'", async () => {
	const { deps, calls } = fakeDeps();
	const result = plan(idle, yes);
	assert.equal(result.notify, true);
	assert.equal(result.text, "⚠️ Estoque da canela: 7 un. (mínimo 10)");
	assert.deepEqual(await settleAlertRun(result, target, deps), { recorded: true, pushed: true });
	assert.equal(calls.records[0]!.next.active, true);
	assert.equal(calls.records[0]!.next.triggeredAt, NOW.toISOString());
	assert.deepEqual(calls.pushes, [{ userId: "user-a", conversationId: "conv-a", text: "⚠️ Estoque da canela: 7 un. (mínimo 10)" }]);
});

test("debounce: continua verdadeira no ciclo seguinte = silêncio (sem push, sem conversa)", async () => {
	const { deps, calls } = fakeDeps();
	const first = plan(idle, yes);
	await settleAlertRun(first, target, deps);
	const second = plan(first.next, { triggered: true, summary: "Estoque da canela: 6 un." });
	assert.equal(second.notify, false);
	assert.equal(second.decision.transition, "still");
	assert.deepEqual(await settleAlertRun(second, target, deps), { recorded: true, pushed: false });
	assert.equal(calls.pushes.length, 1, "só o primeiro ciclo avisou");
	assert.equal(calls.records.at(-1)!.next.active, true);
});

test("volta ao normal rearma, e a próxima virada avisa de novo", async () => {
	const { deps, calls } = fakeDeps();
	let state = idle;
	for (const verdict of [yes, yes, no, no, yes]) {
		const next = plan(state, verdict);
		await settleAlertRun(next, target, deps);
		state = next.next;
	}
	assert.equal(calls.pushes.length, 2, "avisou na 1ª virada e na 2ª, nunca nos ciclos repetidos");
	assert.equal(state.active, true);
});

test("condição falsa: nada na conversa, sem push; só o estado de checagem", async () => {
	const { deps, calls } = fakeDeps();
	const result = plan(idle, no);
	assert.equal(result.notify, false);
	assert.match(result.text, /^Tudo certo/);
	assert.deepEqual(await settleAlertRun(result, target, deps), { recorded: true, pushed: false });
	assert.equal(calls.pushes.length, 0);
	assert.equal(calls.records[0]!.next.active, false);
});

test("sem veredito: avisa uma vez que não conseguiu verificar (motivo do modelo, sem segredo) e fica quieto depois", async () => {
	const { deps, calls } = fakeDeps();
	const first = plan({ ...idle, active: true }, null, "O ERP respondeu 401 com Bearer abcdefghijklmnopqrstuvwxyz0123.\nSegunda linha");
	assert.equal(first.notify, true);
	assert.match(first.text, /^⚠️ Não consegui verificar o alerta “Estoque da canela”: O ERP respondeu 401 com \[redacted\]\.$/);
	assert.equal(first.next.active, true, "não rearma nem desarma");
	assert.equal(first.next.unverified, true);
	await settleAlertRun(first, target, deps);
	const second = plan(first.next, null, "ainda fora do ar");
	assert.equal(second.notify, false);
	await settleAlertRun(second, target, deps);
	assert.equal(calls.pushes.length, 1);
	const recovered = plan(second.next, no);
	assert.equal(recovered.next.unverified, undefined);
	assert.equal(recovered.next.active, false);
});

test("condição editada durante a verificação: resultado descartado, sem push", async () => {
	const { deps, calls } = fakeDeps({ record: async () => false });
	assert.deepEqual(await settleAlertRun(plan(idle, yes), target, deps), { recorded: false, pushed: false });
	assert.equal(calls.pushes.length, 0);
});

test("falha ao gravar o estado não engole o alerta: avisa mesmo assim", async () => {
	const { deps, calls } = fakeDeps({
		record: async () => {
			throw new Error("db fora");
		},
	});
	const originalError = console.error;
	console.error = () => undefined;
	try {
		assert.deepEqual(await settleAlertRun(plan(idle, yes), target, deps), { recorded: true, pushed: true });
	} finally {
		console.error = originalError;
	}
	assert.equal(calls.pushes.length, 1);
});

test("push usa o userId e a conversa do dono; sem push ou sem conversa não quebra", async () => {
	const noPush = fakeDeps({ push: false });
	assert.deepEqual(await settleAlertRun(plan(idle, yes), target, noPush.deps), { recorded: true, pushed: false });
	const noConversation = fakeDeps();
	assert.deepEqual(await settleAlertRun(plan(idle, yes), { ...target, conversationId: null }, noConversation.deps), { recorded: true, pushed: false });
	assert.equal(noConversation.calls.pushes.length, 0);
	const mine = fakeDeps();
	await settleAlertRun(plan(idle, yes), { userId: "user-b", routineId: "r9", conversationId: "conv-b" }, mine.deps);
	assert.equal(mine.calls.records[0]!.userId, "user-b");
	assert.equal(mine.calls.pushes[0]!.userId, "user-b");
	assert.equal(mine.calls.pushes[0]!.conversationId, "conv-b");
});

test("rotina que falhou: push em pt-BR com o motivo amigável, escopado pelo dono, sem vazar o erro técnico", async () => {
	const pushes: string[] = [];
	const asked: Array<[string, string]> = [];
	const deps = {
		loadContext: async (agentRunId: string, userId: string) => {
			asked.push([agentRunId, userId]);
			return userId === "user-a" ? { routineId: "r1", name: "Estoque da canela", conversationId: "conv-a" } : null;
		},
		push: async (_u: string, _c: string, text: string) => void pushes.push(text),
	};
	const error = "Falha após 3 tentativas: 402 This request requires more credits, or fewer max_tokens. Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123";
	assert.equal(await notifyRoutineRunFailure({ origin: "routine", agentRunId: "run-1", userId: "user-a", error }, deps), true);
	assert.deepEqual(pushes, ["Sem créditos no provedor do modelo — a rotina Estoque da canela não rodou"]);
	assert.doesNotMatch(pushes[0]!, /Bearer|abcdefghijkl|max_tokens/);
	assert.deepEqual(asked, [["run-1", "user-a"]]);
	// outro usuário não recebe o aviso dessa rotina; chat/proativo nunca avisam por aqui
	assert.equal(await notifyRoutineRunFailure({ origin: "routine", agentRunId: "run-1", userId: "user-b", error }, deps), false);
	assert.equal(await notifyRoutineRunFailure({ origin: "chat", agentRunId: "run-1", userId: "user-a", error }, deps), false);
	assert.equal(await notifyRoutineRunFailure({ origin: "routine", agentRunId: "run-1", userId: "user-a", error }, { ...deps, push: undefined }), false);
	assert.equal(pushes.length, 1);
});

test("backoff: depois de 3 conferências tranquilas e iguais o intervalo dobra, grava junto do estado e reagenda; disparar volta ao original", async () => {
	const { deps, calls } = fakeDeps();
	let rescheduled = 0;
	const withReschedule = { ...deps, reschedule: async () => void (rescheduled += 1) };
	let alert: RoutineAlert = { ...idle, lastSummary: no.summary };
	let every = 120;
	const recorded: Array<number | undefined> = [];
	const spyDeps = { ...withReschedule, record: async (u: string, r: string, n: RoutineAlert, e?: number) => (recorded.push(e), deps.record(u, r, n, e)) };
	for (let i = 0; i < 3; i += 1) {
		const p = planAlertRun({ alert, routineName: "Estoque", verdict: no, interval: { everyMinutes: every }, now: NOW });
		await settleAlertRun(p, target, spyDeps);
		alert = p.next;
		if (p.everyMinutes) every = p.everyMinutes;
	}
	assert.equal(every, 240);
	assert.deepEqual(recorded, [undefined, undefined, 240]);
	assert.equal(rescheduled, 1);
	assert.deepEqual(alert.backoff, { base: 120, to: 240 });
	const fired = planAlertRun({ alert, routineName: "Estoque", verdict: yes, interval: { everyMinutes: every }, now: NOW });
	assert.equal(fired.everyMinutes, 120);
	assert.equal(fired.next.backoff, undefined);
	assert.equal(fired.notify, true);
	void calls;
});

test("alerta por horário (cron) não tem backoff: nenhuma mudança de intervalo nem campos de estado extras", () => {
	let alert: RoutineAlert = { ...idle, lastSummary: no.summary };
	for (let i = 0; i < 5; i += 1) {
		const p = planAlertRun({ alert, routineName: "Estoque", verdict: no, interval: null, now: NOW });
		assert.equal(p.everyMinutes, undefined);
		alert = p.next;
	}
	assert.equal(alert.quietStreak, undefined);
	assert.equal(alert.backoff, undefined);
});

test("reagendamento que falha não derruba o alerta: o estado segue gravado", async () => {
	const { deps } = fakeDeps();
	const p = planAlertRun({ alert: { ...idle, lastSummary: no.summary, quietStreak: 2 }, routineName: "Estoque", verdict: no, interval: { everyMinutes: 120 }, now: NOW });
	assert.equal(p.everyMinutes, 240);
	const result = await settleAlertRun(p, target, { ...deps, reschedule: async () => { throw new Error("redis fora"); } });
	assert.deepEqual(result, { recorded: true, pushed: false });
});

test("post: o aviso entra na conversa só quando avisa e só depois de gravar o estado; falha do post não derruba o push", async () => {
	const { deps } = fakeDeps();
	const posts: string[] = [];
	const order: string[] = [];
	const origins: string[] = [];
	const withPost = {
		...deps,
		record: async (...args: Parameters<typeof deps.record>) => {
			order.push("record");
			return deps.record(...args);
		},
		post: async (_conversationId: string, text: string, origin: "routine") => {
			order.push("post");
			posts.push(text);
			origins.push(origin);
		},
	};
	await settleAlertRun(plan(idle, yes), target, withPost);
	assert.deepEqual(order, ["record", "post"]);
	assert.deepEqual(posts, ["⚠️ Estoque da canela: 7 un. (mínimo 10)"]);
	// Gravada como saída automatizada: no histórico do modelo ganha o rótulo e não passa por fala do bot.
	assert.deepEqual(origins, ["routine"]);
	const history = foldAutomatedMessages([{ role: "assistant", content: posts[0]!, origin: origins[0] }]);
	assert.match(history[0]!.content, /^\[Automated run - not a user request\]\n/);
	await settleAlertRun(plan(idle, no), target, withPost);
	assert.equal(posts.length, 1, "sem aviso não posta");
	const failing = { ...withPost, post: async () => { throw new Error("db fora"); } };
	assert.deepEqual(await settleAlertRun(plan(idle, yes), target, failing), { recorded: true, pushed: true });
	const discarded = { ...withPost, record: async () => false };
	posts.length = 0;
	await settleAlertRun(plan(idle, yes), target, discarded);
	assert.equal(posts.length, 0, "estado descartado (condição editada) não avisa");
});
