/**
 * Herança do run pai: a continuação automática (falha transitória) e a resposta de questionário/cartão dentro de um trabalho
 * longo do dono seguem como turno do dono, no mesmo motor e perfil. Prisma em memória.
 * Runner: `pnpm exec tsx --test src/run-inheritance.test.ts` em packages/db.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { RunInputRecord } from "@workspace/shared";
import { buildQueuedRunData, createFollowUpRun, inheritanceFromRun, getConversationInheritance, lastChatRunStoppedWithOpenWork, readRunHumanTurn, readRunInheritance } from "./runs.js";
import { FakeTable, installFakes } from "./testing/fake-tables.js";

let runs: FakeTable;
let inputs: FakeTable;
let installed: { restore: () => void };

const LONG_WORK_PARENT = { humanTurn: true, engine: "v2", engineProfile: "long_work", contextLength: 1000 };

const request = (objective: string) => ({
	messages: [{ role: "user" as const, content: objective }],
	model: "m",
	conversationId: "conv-1",
	origin: "chat" as const,
	objective,
	silent: true,
});

const queued = (): RunInputRecord => ({
	id: "i1",
	runId: "parent",
	seq: 1,
	author: "agent",
	content: "Continue",
	mode: "queue",
	status: "pending",
	clientKey: null,
	createdAt: new Date().toISOString(),
	consumedAt: null,
});

beforeEach(() => {
	runs = new FakeTable(
		[{ id: "parent", userId: "u1", conversationId: "conv-1", origin: "chat", status: "failed", cancelRequested: false, createdAt: new Date(1000), budgetJson: LONG_WORK_PARENT }],
		() => ({ cancelRequested: false, jobEnqueuedAt: null, parentRunId: null, error: null, resultText: null, startedAt: null, finishedAt: null, createdAt: new Date(), updatedAt: new Date() }),
	);
	inputs = new FakeTable([{ id: "i1", runId: "parent", seq: 1, author: "agent", content: "Continue", attachmentsJson: null, mode: "queue", status: "pending", clientKey: null, createdAt: new Date(), consumedAt: null }]);
	const conversation = new FakeTable();
	conversation.findFirst = async () => ({ id: "conv-1" });
	installed = installFakes({ agentRun: runs, runInput: inputs, conversation });
});
afterEach(() => installed.restore());

const child = (result: Awaited<ReturnType<typeof createFollowUpRun>>) => {
	assert.equal(result.outcome, "created");
	return runs.rows.find((row) => row.id === (result.outcome === "created" ? result.run.id : ""))!;
};

test("continuação automática herda do pai o turno do dono, o motor e o perfil (long_work segue long_work)", async () => {
	const result = await createFollowUpRun({ parentRunId: "parent", userId: "u1", model: "m", request: request("Continue"), consume: [queued()], inheritFromParent: true });
	const run = child(result);
	assert.equal(readRunHumanTurn(run), true);
	assert.deepEqual(readRunInheritance(run), { humanTurn: true, engine: "v2", profile: "long_work" });
});

test("follow-up comum (mensagem nova na fila) NÃO herda: o perfil é decidido pelo texto novo", async () => {
	const result = await createFollowUpRun({ parentRunId: "parent", userId: "u1", model: "m", request: request("ok, obrigado"), consume: [queued()] });
	const run = child(result);
	assert.equal(readRunHumanTurn(run), false);
	assert.deepEqual(readRunInheritance(run), { humanTurn: false });
});

test("pai que não era turno do dono (rotina, bot→bot) não passa turno humano; motor e perfil continuam herdados", async () => {
	runs.rows[0]!.budgetJson = { engine: "v2", engineProfile: "long_work" };
	const result = await createFollowUpRun({ parentRunId: "parent", userId: "u1", model: "m", request: request("Continue"), consume: [queued()], inheritFromParent: true });
	assert.deepEqual(readRunInheritance(child(result)), { humanTurn: false, engine: "v2", profile: "long_work" });
});

test("resposta de questionário/cartão herda do último run de chat da conversa do dono", async () => {
	runs.rows.push({ id: "later", userId: "u1", conversationId: "conv-1", origin: "chat", status: "completed", createdAt: new Date(5000), budgetJson: LONG_WORK_PARENT });
	runs.rows.push({ id: "routine", userId: "u1", conversationId: "conv-1", origin: "routine", status: "completed", createdAt: new Date(9000), budgetJson: { engine: "v1" } });
	assert.deepEqual(await getConversationInheritance("u1", "conv-1"), { humanTurn: true, engine: "v2", profile: "long_work" });
	// Outro dono não herda nada da conversa.
	assert.deepEqual(await getConversationInheritance("u2", "conv-1"), { humanTurn: false });
	assert.deepEqual(await getConversationInheritance("u1", undefined), { humanTurn: false });
});

test("buildQueuedRunData grava o herdado no budgetJson sem perder o resto; sem herança nada muda", () => {
	const inherited = { humanTurn: true, engine: "v2" as const, profile: "long_work" as const };
	const data = buildQueuedRunData({ request: { messages: [{ role: "user", content: "x" }], budget: { maxCostUsd: 1 } }, model: "m", userId: "u1", conversationId: "conv-1", contextLength: 1000, inherited });
	assert.deepEqual(data.budgetJson, { maxCostUsd: 1, contextLength: 1000, humanTurn: true, engine: "v2", engineProfile: "long_work" });
	const plain = buildQueuedRunData({ request: { messages: [{ role: "user", content: "x" }] }, model: "m", userId: "u1", conversationId: "conv-1" });
	assert.equal(plain.budgetJson, undefined);
});

test("escopo: o estado 'parou com itens abertos' é do dono; o usuário B não herda o do usuário A (nem com o legado default)", async () => {
	runs.rows.push({ id: "open", userId: "u1", conversationId: "conv-1", origin: "chat", status: "completed", createdAt: new Date(5000), stopReason: "budget_steps", stopDetail: "delivered:items_open", budgetJson: LONG_WORK_PARENT });
	assert.equal(await lastChatRunStoppedWithOpenWork("u1", "conv-1"), true);
	// Outro dono, mesma conversa: nada.
	assert.equal(await lastChatRunStoppedWithOpenWork("u2", "conv-1"), false);
	assert.equal(await lastChatRunStoppedWithOpenWork("default", "conv-1"), false);
	assert.equal(await lastChatRunStoppedWithOpenWork("u1", undefined), false);
	// O próprio run em andamento é excluído; teto sem itens abertos não conta.
	assert.equal(await lastChatRunStoppedWithOpenWork("u1", "conv-1", { excludeRunId: "open" }), false);
	runs.rows.push({ id: "capped", userId: "u1", conversationId: "conv-1", origin: "chat", status: "completed", createdAt: new Date(7000), stopReason: "budget_steps", stopDetail: "delivered", budgetJson: LONG_WORK_PARENT });
	assert.equal(await lastChatRunStoppedWithOpenWork("u1", "conv-1"), false);
});

test("run do motor v3 passa o motor cru adiante (o worker decide de novo pela flag)", () => {
	assert.deepEqual(readRunInheritance({ budgetJson: { engine: "v3", engineProfile: "chat", humanTurn: true } }), { humanTurn: true, engine: "v3", profile: "chat" });
});

test("retorno agendado (v3): herda motor e perfil do run que agendou, nunca o turno humano", () => {
	const source = { budgetJson: { humanTurn: true, engine: "v3", engineProfile: "long_work" } };
	assert.deepEqual(inheritanceFromRun(source), { humanTurn: true, engine: "v3", profile: "long_work" });
	const inherited = inheritanceFromRun(source, false);
	assert.deepEqual(inherited, { humanTurn: false, engine: "v3", profile: "long_work" });
	const data = buildQueuedRunData({ request: request("[Scheduled return] x"), model: "m", userId: "u", conversationId: "conv-1", inherited });
	assert.equal(readRunHumanTurn({ budgetJson: data.budgetJson }), false);
	assert.equal((data.budgetJson as Record<string, unknown>).engine, "v3");
});
