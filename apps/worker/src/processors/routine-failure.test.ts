import assert from "node:assert/strict";
import { test } from "node:test";
import { formatRoutineFailureNotice, reportRoutineFailure, shortReason, type RoutineFailureDeps } from "./routine-failure.js";

const AT = new Date("2026-10-17T11:00:00.000Z"); // 08:00 em São Paulo

test("aviso: nome, horário local e motivo curto", () => {
	const text = formatRoutineFailureNotice({ name: "Resumo da manhã", at: AT, timezone: "America/Sao_Paulo", reason: "Redis fora do ar.\nstack..." });
	assert.equal(text, "A rotina “Resumo da manhã” não rodou às 08:00: Redis fora do ar. Abra a rotina para tentar de novo.");
	assert.ok(!/Atlas/i.test(text));
});

test("shortReason corta motivo longo e cobre vazio", () => {
	assert.equal(shortReason("").length > 0, true);
	assert.ok(shortReason("x".repeat(500)).length <= 120);
});

function fakeDeps(over: Partial<RoutineFailureDeps> = {}) {
	const calls = { failed: [] as string[], created: 0, messages: [] as string[], pushes: [] as string[] };
	const deps: RoutineFailureDeps = {
		loadRoutine: async () => ({ id: "r1", name: "Rotina", timezone: "America/Sao_Paulo", userId: "u1", conversationId: "c1" }),
		markRunFailed: async (id) => {
			calls.failed.push(id);
			return calls.failed.filter((x) => x === id).length === 1;
		},
		findOpenRun: async () => null,
		createFailedRun: async () => {
			calls.created += 1;
			return "new-run";
		},
		appendMessage: async (_c, text) => void calls.messages.push(text),
		push: async (_u, _c, text) => void calls.pushes.push(text),
		...over,
	};
	return { deps, calls };
}

const payload = { routineId: "r1", triggeredBy: "schedule" as const };

test("falha final com RoutineRun no payload: marca falha, mensagem na conversa e push, uma vez", async () => {
	const { deps, calls } = fakeDeps();
	const input = { payload: { ...payload, routineRunId: "run1" }, reason: "boom", at: AT, openedAfter: AT };
	assert.deepEqual(await reportRoutineFailure(input, deps), { notified: true });
	assert.deepEqual(await reportRoutineFailure(input, deps), { notified: false });
	assert.equal(calls.messages.length, 1);
	assert.equal(calls.pushes.length, 1);
	assert.match(calls.messages[0]!, /não rodou às 08:00: boom/);
});

test("falha antes de existir RoutineRun: cria uma já como falha", async () => {
	const { deps, calls } = fakeDeps();
	const result = await reportRoutineFailure({ payload, reason: "Routine not found", at: AT, openedAfter: AT }, deps);
	assert.equal(result.notified, true);
	assert.equal(calls.created, 1);
});

test("RoutineRun aberta achada pela busca é a que vira falha", async () => {
	const { deps, calls } = fakeDeps({ findOpenRun: async () => "open1" });
	await reportRoutineFailure({ payload, reason: "x", at: AT, openedAfter: AT }, deps);
	assert.deepEqual(calls.failed, ["open1"]);
	assert.equal(calls.created, 0);
});

test("desistência (execução já fechada como pulada) só avisa, sem marcar de novo", async () => {
	const { deps, calls } = fakeDeps();
	const result = await reportRoutineFailure({ payload, reason: "O bot já está ocupado (desisti após 30 min de espera)", at: AT, openedAfter: AT, alreadyClosedRunId: "run9" }, deps);
	assert.equal(result.notified, true);
	assert.equal(calls.failed.length, 0);
});

test("sem conversa do bot ou sem rotina: não avisa e não lança; push ausente não quebra", async () => {
	const noConv = fakeDeps({ loadRoutine: async () => ({ id: "r1", name: "R", timezone: null, userId: "u1", conversationId: null }) });
	assert.equal((await reportRoutineFailure({ payload, reason: "x", at: AT, openedAfter: AT }, noConv.deps)).notified, false);
	const gone = fakeDeps({ loadRoutine: async () => null });
	assert.equal((await reportRoutineFailure({ payload, reason: "x", at: AT, openedAfter: AT }, gone.deps)).notified, false);
	const noPush = fakeDeps({ push: undefined });
	assert.equal((await reportRoutineFailure({ payload, reason: "x", at: AT, openedAfter: AT }, noPush.deps)).notified, true);
	assert.equal(noPush.calls.messages.length, 1);
});
