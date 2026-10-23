import assert from "node:assert/strict";
import test from "node:test";
import { notifyRoutineRunFailure, type RoutineRunFailureDeps } from "./routine-run-failure.js";

function deps(ctx: Awaited<ReturnType<RoutineRunFailureDeps["loadContext"]>>) {
	const pushed: string[] = [];
	const loads: Array<[string, string]> = [];
	const d: RoutineRunFailureDeps = {
		loadContext: async (runId, userId) => (loads.push([runId, userId]), ctx),
		push: async (_u, _c, text) => void pushed.push(text),
	};
	return { d, pushed, loads };
}

test("rotina que falhou: push com motivo amigável, sem o erro técnico", async () => {
	const { d, pushed, loads } = deps({ routineId: "r1", name: "Estoque", conversationId: "c1" });
	const ok = await notifyRoutineRunFailure({ origin: "routine", agentRunId: "run1", userId: "u1", error: "402 This request requires more credits sk-or-v1-abcdef1234567890abcdef" }, d);
	assert.equal(ok, true);
	assert.deepEqual(loads, [["run1", "u1"]]);
	assert.match(pushed[0]!, /Estoque/);
	assert.doesNotMatch(pushed[0]!, /sk-or|402/);
});

test("run que não é de rotina, sem dono, sem conversa ou sem push: não avisa", async () => {
	const a = deps({ routineId: "r1", name: "X", conversationId: "c1" });
	assert.equal(await notifyRoutineRunFailure({ origin: "chat", agentRunId: "r", userId: "u1", error: "x" }, a.d), false);
	assert.equal(await notifyRoutineRunFailure({ origin: "routine", agentRunId: "r", userId: null, error: "x" }, a.d), false);
	const b = deps({ routineId: "r1", name: "X", conversationId: null });
	assert.equal(await notifyRoutineRunFailure({ origin: "routine", agentRunId: "r", userId: "u1", error: "x" }, b.d), false);
	assert.equal(await notifyRoutineRunFailure({ origin: "routine", agentRunId: "r", userId: "u1", error: "x" }, { loadContext: b.d.loadContext }), false);
	assert.equal(a.pushed.length + b.pushed.length, 0);
});

test("outro dono (contexto nulo) ou falha ao carregar não derruba nem avisa", async () => {
	const none = deps(null);
	assert.equal(await notifyRoutineRunFailure({ origin: "routine", agentRunId: "r", userId: "u2", error: "x" }, none.d), false);
	const boom: RoutineRunFailureDeps = { loadContext: async () => { throw new Error("db"); }, push: async () => undefined };
	assert.equal(await notifyRoutineRunFailure({ origin: "routine", agentRunId: "r", userId: "u1", error: "x" }, boom), false);
});
