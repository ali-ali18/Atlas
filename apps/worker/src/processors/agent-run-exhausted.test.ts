/**
 * A9 — retries da fila esgotados: o run fecha como falha normal, com mensagem amigável,
 * entrega liquidada e mensagens pendentes encadeadas. O texto técnico fica em `error`.
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/processors/agent-run-exhausted.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRun } from "@workspace/shared";
import { finalizeExhaustedAgentRun } from "./agent-run.js";

const run = { id: "r1", userId: "u1", origin: "chat", conversationId: "c1" } as unknown as AgentRun;

function io(overrides: { finalized?: boolean; origin?: string } = {}) {
	const calls: { fail?: { error: string; resultText: string }; settle?: unknown; chain?: string } = {};
	return {
		calls,
		io: {
			getRun: async () => ({ ...run, origin: overrides.origin ?? "chat" }) as AgentRun,
			failRun: async (_id: string, error: string, display: { resultText: string }) => {
				calls.fail = { error, resultText: display.resultText };
				return overrides.finalized ?? true;
			},
			settle: async (input: unknown) => {
				calls.settle = input;
			},
			chain: async (r: AgentRun) => {
				calls.chain = r.id;
			},
		},
	};
}

test("esgotado: resultText amigável, técnico em error, entrega liquidada e pendentes encadeados", async () => {
	const { calls, io: fakes } = io();
	const err = Object.assign(new Error("Provider returned error: 429 raw upstream text"), { status: 429, name: "OpenRouterError" });
	assert.equal(await finalizeExhaustedAgentRun("r1", err, 3, {}, fakes), true);
	assert.match(calls.fail!.error, /^Falha após 3 tentativas: Provider returned error/);
	assert.equal(calls.fail!.resultText, "O provedor do modelo está limitando pedidos agora. Tente em alguns minutos ou troque de modelo.");
	assert.deepEqual(calls.settle, { userId: "u1", runId: "r1", end: "failed", resultText: calls.fail!.resultText });
	assert.equal(calls.chain, "r1");
});

test("timeout cru vira mensagem de timeout, nunca 'aborted due to timeout'", async () => {
	const { calls, io: fakes } = io();
	const err = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
	await finalizeExhaustedAgentRun("r1", err, 3, {}, fakes);
	assert.doesNotMatch(calls.fail!.resultText, /aborted/);
	assert.match(calls.fail!.resultText, /demorou demais/);
});

test("run já finalizado por outro caminho (cancel/pausa): não liquida nem encadeia", async () => {
	const { calls, io: fakes } = io({ finalized: false });
	assert.equal(await finalizeExhaustedAgentRun("r1", new Error("x"), 3, {}, fakes), false);
	assert.equal(calls.settle, undefined);
	assert.equal(calls.chain, undefined);
});

test("run proativo nunca mostra texto técnico ao usuário", async () => {
	const { calls, io: fakes } = io({ origin: "proactive" });
	await finalizeExhaustedAgentRun("r1", new Error("boom"), 3, {}, fakes);
	assert.doesNotMatch(calls.fail!.resultText, /boom/);
});

test("falha ao liquidar não impede encadear os pendentes", async () => {
	const { calls, io: fakes } = io();
	fakes.settle = async () => {
		throw new Error("db down");
	};
	assert.equal(await finalizeExhaustedAgentRun("r1", new Error("x"), 3, {}, fakes), true);
	assert.equal(calls.chain, "r1");
});

test("rotina que esgotou as tentativas: avisa o dono uma vez, com o erro técnico só como entrada do formatador", async () => {
	const { io: fakes } = io({ origin: "routine" });
	const pushed: Array<{ origin: unknown; agentRunId: string; userId: string; error: string }> = [];
	const withNotify = { ...fakes, notifyRoutineFailure: async (input: (typeof pushed)[number]) => void pushed.push(input) };
	const err = new Error("402 This request requires more credits");
	assert.equal(await finalizeExhaustedAgentRun("r1", err, 3, {}, withNotify), true);
	assert.equal(pushed.length, 1);
	assert.equal(pushed[0]!.origin, "routine");
	assert.equal(pushed[0]!.userId, "u1");
	assert.match(pushed[0]!.error, /requires more credits/);
});

test("run finalizado por outro caminho não dispara o aviso de rotina", async () => {
	const { io: fakes } = io({ origin: "routine", finalized: false });
	let called = 0;
	await finalizeExhaustedAgentRun("r1", new Error("x"), 3, {}, { ...fakes, notifyRoutineFailure: async () => void (called += 1) });
	assert.equal(called, 0);
});
