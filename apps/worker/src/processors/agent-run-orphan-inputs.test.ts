/**
 * V2 — join órfão: a mensagem enviada a um run ativo que foi parado antes de
 * consumi-la vira o próximo turno (uma vez, do mesmo dono). Prisma em memória.
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/processors/agent-run-orphan-inputs.test.ts`.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { FakeTable, installFakes } from "@workspace/db/testing";
import type { WorkerConfig } from "../config.js";
import { chainRunFollowUp, processAgentRunJob } from "./agent-run.js";

let runs: FakeTable;
let inputs: FakeTable;
let installed: { restore: () => void };

const old = () => new Date(Date.now() - 120_000);

const runRow = (id: string, userId: string, status: string) => ({
	id,
	userId,
	conversationId: "conv-1",
	botId: null,
	model: "m",
	origin: "chat",
	status,
	cancelRequested: status === "cancelled",
	createdAt: old(),
	updatedAt: old(),
});

const inputRow = (id: string, runId: string, mode: string, content: string, seq: number) => ({
	id,
	runId,
	seq,
	author: "user",
	content,
	attachmentsJson: null,
	mode,
	status: "pending",
	clientKey: null,
	createdAt: old(),
	consumedAt: null,
});

beforeEach(() => {
	runs = new FakeTable([], () => ({
		cancelRequested: false,
		createdAt: new Date(),
		updatedAt: new Date(),
		jobEnqueuedAt: null,
		parentRunId: null,
		error: null,
		resultText: null,
		startedAt: null,
		finishedAt: null,
		checkpointJson: null,
	}));
	inputs = new FakeTable([]);
	const conversation = new FakeTable();
	conversation.findFirst = async () => ({ id: "conv-1" });
	installed = installFakes({ agentRun: runs, runInput: inputs, conversation, runEvent: new FakeTable() });
});
afterEach(() => installed.restore());

const config = { openRouterApiKey: "test-key" } as WorkerConfig;
const children = () => runs.rows.filter((row) => row.id !== "r1");

test("run parado com join pendente: o join vira um follow-up enfileirado, sem repetir a parada", async () => {
	runs.rows = [runRow("r1", "u1", "cancelled")];
	inputs.rows = [
		inputRow("i1", "r1", "join", "Veja somente as favoritas", 1),
		inputRow("i2", "r1", "cancel", "para", 2),
	];
	const enqueued: string[] = [];
	const result = await processAgentRunJob({ runId: "r1" }, config, "owner", {
		enqueueNextRun: async (id) => (enqueued.push(id), true),
	});
	assert.equal(result.status, "cancelled");
	assert.equal(children().length, 1);
	assert.deepEqual(enqueued, [children()[0]!.id]);
	assert.equal(inputs.rows.find((row) => row.id === "i1")!.status, "consumed");
	assert.equal(inputs.rows.find((row) => row.id === "i2")!.status, "pending", "a parada em si não vira turno");
});

test("reentrega do job do run parado não cria um segundo follow-up", async () => {
	runs.rows = [runRow("r1", "u1", "cancelled")];
	inputs.rows = [inputRow("i1", "r1", "join", "oi", 1)];
	const deps = { enqueueNextRun: async () => true };
	await processAgentRunJob({ runId: "r1" }, config, "owner", deps);
	await processAgentRunJob({ runId: "r1" }, config, "owner", deps);
	assert.equal(children().length, 1);
});

test("chainRunFollowUp: entrada de outro run/dono não é promovida pelo run do usuário A", async () => {
	runs.rows = [runRow("r1", "u1", "cancelled"), runRow("r2", "u2", "cancelled")];
	inputs.rows = [inputRow("i1", "r1", "join", "do A", 1), inputRow("i2", "r2", "join", "do B", 1)];
	await chainRunFollowUp(runs.rows[0] as never, "u1", { enqueueNextRun: async () => true });
	assert.equal(inputs.rows.find((row) => row.id === "i1")!.status, "consumed");
	assert.equal(inputs.rows.find((row) => row.id === "i2")!.status, "pending");
	const created = runs.rows.filter((row) => !["r1", "r2"].includes(row.id as string));
	assert.equal(created.length, 1);
	assert.equal(created[0]!.userId, "u1");
});
