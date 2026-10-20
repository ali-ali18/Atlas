/**
 * Retomada automática no lugar de "responda continuar".
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/auto-continue.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRun } from "@workspace/shared";
import { BudgetExhaustedError } from "@workspace/agent-runtime";
import {
	AUTO_CONTINUE_INSTRUCTION,
	AUTO_CONTINUE_MAX,
	AUTO_CONTINUE_STATUS_TEXT,
	autoContinueCauseOfBudgetStop,
	autoContinueCauseOfFailure,
	continuationBudget,
	decideAutoContinue,
	planAutoContinue,
	readAutoContinueAttempt,
	scheduleAutoContinue,
	type AutoContinueDecision,
	type AutoContinueIo,
} from "./auto-continue.js";
import { finalizeExhaustedAgentRun } from "./processors/agent-run.js";
import { followUpRequest } from "./follow-up.js";

const run = (over: Partial<AgentRun> & { budgetJson?: unknown } = {}) => ({ id: "r1", userId: "u1", origin: "chat", conversationId: "c1", model: "m", cancelRequested: false, budgetJson: null, ...over }) as unknown as AgentRun;

function fakeIo(over: { pending?: boolean; progress?: number } = {}) {
	const calls = { inputs: [] as string[], chains: [] as AutoContinueDecision[] };
	const io: AutoContinueIo = {
		hasPendingInput: async () => over.pending ?? false,
		countProgress: async () => over.progress ?? 3,
		addInput: async (_runId, _userId, _content, key) => void calls.inputs.push(key),
		chain: async (_run, _user, decision) => {
			calls.chains.push(decision);
			return "created";
		},
	};
	return { io, calls };
}

const transient = Object.assign(new Error("Provider returned error: 503 overloaded"), { status: 503, name: "OpenRouterError" });
const base = { cause: "transient" as const, origin: "chat", attempt: 0, progress: 4, hasPendingInput: false };

test("falha transitória com progresso: agenda uma retomada com espera crescente", () => {
	const first = decideAutoContinue(base);
	assert.deepEqual(first, { schedule: true, cause: "transient", attempt: 1, delayMs: 20_000 });
	const second = decideAutoContinue({ ...base, attempt: 1 });
	assert.deepEqual(second, { schedule: true, cause: "transient", attempt: 2, delayMs: 60_000 });
});

test("teto de 2 retomadas por turno: a terceira não agenda e o fechamento comum vale", () => {
	assert.equal(AUTO_CONTINUE_MAX, 2);
	assert.deepEqual(decideAutoContinue({ ...base, attempt: 2 }), { schedule: false, reason: "exhausted" });
	assert.deepEqual(decideAutoContinue({ ...base, cause: "steps", attempt: 3 }), { schedule: false, reason: "exhausted" });
});

test("sem progresso na última tentativa: para, mesmo com tentativas sobrando", () => {
	assert.deepEqual(decideAutoContinue({ ...base, progress: 0 }), { schedule: false, reason: "no_progress" });
	assert.deepEqual(decideAutoContinue({ ...base, cause: "steps", attempt: 1, progress: 0 }), { schedule: false, reason: "no_progress" });
});

test("paradas por orçamento: só o teto de passos é recuperável; relógio, custo, tokens, contexto e parada sem evidência nunca", () => {
	assert.equal(autoContinueCauseOfBudgetStop(new BudgetExhaustedError("x", "steps")), "steps");
	for (const kind of ["wall", "cost", "tokens", "context", "stalled", "other"] as const) {
		assert.equal(autoContinueCauseOfBudgetStop(new BudgetExhaustedError("x", kind)), null, kind);
		assert.deepEqual(decideAutoContinue({ ...base, cause: autoContinueCauseOfBudgetStop(new BudgetExhaustedError("x", kind)) }), { schedule: false, reason: "not_recoverable" });
	}
});

test("falhas permanentes (chave, requisição recusada, permissão) não retomam", () => {
	assert.equal(autoContinueCauseOfFailure(transient), "transient");
	assert.equal(autoContinueCauseOfFailure(Object.assign(new Error("Forbidden"), { status: 403 })), null);
	assert.equal(autoContinueCauseOfFailure(new Error("argumentos inválidos (JSON)")), null);
});

test("entrada do usuário pendente, origem automática e cancelamento não retomam", () => {
	assert.deepEqual(decideAutoContinue({ ...base, hasPendingInput: true }), { schedule: false, reason: "pending_input" });
	for (const origin of ["routine", "webhook", "proactive", "bot"]) assert.deepEqual(decideAutoContinue({ ...base, origin }), { schedule: false, reason: "origin" });
	assert.deepEqual(decideAutoContinue({ ...base, cancelRequested: true }), { schedule: false, reason: "cancelled" });
});

test("limite de custo do usuário: retoma só com o que sobrou, e nunca com o limite já gasto", () => {
	const left = decideAutoContinue({ ...base, costCapUsd: 0.5, costUsedUsd: 0.2 });
	assert.ok(left.schedule);
	assert.ok(Math.abs(left.maxCostUsd! - 0.3) < 1e-9);
	assert.deepEqual(continuationBudget(left as Extract<AutoContinueDecision, { schedule: true }>), { autoContinue: { attempt: 1 }, maxCostUsd: left.maxCostUsd });
	assert.deepEqual(decideAutoContinue({ ...base, costCapUsd: 0.5, costUsedUsd: 0.5 }), { schedule: false, reason: "cost_cap" });
	assert.deepEqual(decideAutoContinue({ ...base, costCapUsd: 0.5, costUsedUsd: 0.9 }), { schedule: false, reason: "cost_cap" });
});

test("o contador vem do orçamento gravado no run de continuação", () => {
	assert.equal(readAutoContinueAttempt(null), 0);
	assert.equal(readAutoContinueAttempt({ autoContinue: { attempt: 2 } }), 2);
	assert.equal(readAutoContinueAttempt({ autoContinue: { attempt: -1 } }), 0);
	const request = followUpRequest({ model: "m", conversationId: "c1", origin: "chat", budget: { autoContinue: { attempt: 1 } } }, { objective: AUTO_CONTINUE_INSTRUCTION, attachments: [], consume: [], defer: [] });
	assert.deepEqual(request.budget, { autoContinue: { attempt: 1 } });
	assert.equal(request.silent, true);
});

test("plano: lê o banco só depois das barreiras baratas e respeita o contador do run", async () => {
	const { io } = fakeIo({ progress: 2 });
	assert.deepEqual(await planAutoContinue(run(), { cause: "transient" }, io), { schedule: true, cause: "transient", attempt: 1, delayMs: 20_000 });
	assert.deepEqual(await planAutoContinue(run({ budgetJson: { autoContinue: { attempt: 1 } } } as never), { cause: "steps", progress: 5 }, io), { schedule: true, cause: "steps", attempt: 2, delayMs: 2_000 });
	assert.deepEqual(await planAutoContinue(run({ budgetJson: { autoContinue: { attempt: 2 } } } as never), { cause: "steps", progress: 5 }, io), { schedule: false, reason: "exhausted" });
	let touched = 0;
	const spy: Pick<AutoContinueIo, "hasPendingInput" | "countProgress"> = { hasPendingInput: async () => (touched++, false), countProgress: async () => (touched++, 1) };
	assert.deepEqual(await planAutoContinue(run({ origin: "routine" }), { cause: "steps" }, spy), { schedule: false, reason: "origin" });
	assert.equal(touched, 0);
	assert.deepEqual(await planAutoContinue(run(), { cause: "transient" }, fakeIo({ progress: 0 }).io), { schedule: false, reason: "no_progress" });
	assert.deepEqual(await planAutoContinue(run(), { cause: "transient" }, fakeIo({ pending: true }).io), { schedule: false, reason: "pending_input" });
});

test("agendar: uma entrada com chave estável do run e uma continuação; falha do IO não lança", async () => {
	const { io, calls } = fakeIo();
	const decision = decideAutoContinue(base) as Extract<AutoContinueDecision, { schedule: true }>;
	assert.equal(await scheduleAutoContinue(run(), "u1", decision, io), "created");
	assert.deepEqual(calls.inputs, ["auto-continue:r1"]);
	assert.equal(calls.chains.length, 1);
	const broken: Pick<AutoContinueIo, "addInput" | "chain"> = { addInput: async () => { throw new Error("db fora"); }, chain: async () => "created" };
	const originalError = console.error;
	console.error = () => undefined;
	try {
		assert.equal(await scheduleAutoContinue(run(), "u1", decision, broken), "none");
	} finally {
		console.error = originalError;
	}
});

function exhaustedIo(auto: AutoContinueIo, runOver: Partial<AgentRun> = {}) {
	const calls: { fail?: { error: string; resultText: string }; settle: Array<{ end: string; resultText?: string }>; chain: number; appended: string[] } = { settle: [], chain: 0, appended: [] };
	return {
		calls,
		io: {
			getRun: async () => run(runOver),
			failRun: async (_id: string, error: string, display: { resultText: string }) => {
				calls.fail = { error, resultText: display.resultText };
				return true;
			},
			settle: async (input: { end: string; resultText?: string }) => void calls.settle.push({ end: input.end, resultText: input.resultText }),
			chain: async () => void (calls.chain += 1),
			appendAssistant: async (_conversationId: string, text: string) => void calls.appended.push(text),
			autoContinue: auto,
		},
	};
}

test("fila esgotada por erro transitório com progresso: retomada agendada uma vez, status neutro e sem erro no chat", async () => {
	const { io: auto, calls: autoCalls } = fakeIo();
	const { io, calls } = exhaustedIo(auto);
	assert.equal(await finalizeExhaustedAgentRun("r1", transient, 3, {}, io), true);
	assert.equal(calls.fail!.resultText, AUTO_CONTINUE_STATUS_TEXT);
	assert.match(calls.fail!.error, /^Falha após 3 tentativas/);
	assert.equal(autoCalls.chains.length, 1);
	assert.deepEqual(autoCalls.inputs, ["auto-continue:r1"]);
	assert.deepEqual(calls.settle.map((item) => item.end), ["cancelled"]);
	assert.equal(calls.chain, 0);
});

test("fila esgotada: sem progresso, no limite de retomadas ou erro permanente mantém o fechamento de falha de sempre", async () => {
	const cases: Array<[string, AutoContinueIo, Partial<AgentRun>, Error]> = [
		["sem progresso", fakeIo({ progress: 0 }).io, {}, transient],
		["limite do turno", fakeIo().io, { budgetJson: { autoContinue: { attempt: AUTO_CONTINUE_MAX } } } as never, transient],
		["erro permanente", fakeIo().io, {}, Object.assign(new Error("Unauthorized"), { status: 401 })],
		["rotina", fakeIo().io, { origin: "routine" }, transient],
	];
	for (const [name, auto, over, err] of cases) {
		const { io, calls } = exhaustedIo(auto, over);
		await finalizeExhaustedAgentRun("r1", err, 3, {}, io);
		assert.notEqual(calls.fail!.resultText, AUTO_CONTINUE_STATUS_TEXT, name);
		assert.deepEqual(calls.settle.map((item) => item.end), ["failed"], name);
		assert.equal(calls.chain, 1, name);
	}
});

test("a retomada não saiu do papel: o fechamento de falha de sempre ainda é liquidado", async () => {
	const { io: auto } = fakeIo();
	const failing: AutoContinueIo = { ...auto, chain: async () => "none" };
	const { io, calls } = exhaustedIo(failing);
	await finalizeExhaustedAgentRun("r1", transient, 3, {}, io);
	assert.deepEqual(calls.settle.map((item) => item.end), ["failed"]);
	assert.equal(calls.chain, 1);
	assert.equal(calls.appended.length, 1);
	assert.notEqual(calls.appended[0], AUTO_CONTINUE_STATUS_TEXT);
});
