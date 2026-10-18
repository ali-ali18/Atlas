/**
 * F2 (W5/W8) — follow-up do fim do run: criar o run e consumir os inputs numa
 * transação só. Prisma em memória. Runner:
 * `pnpm exec tsx --test src/run-followup.test.ts` em packages/db.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { RunInputRecord } from "@workspace/shared";
import { createFollowUpRun, listQueuedRunsMissingJob } from "./runs.js";
import { FakeTable, installFakes } from "./testing/fake-tables.js";

let runs: FakeTable;
let inputs: FakeTable;
let installed: { restore: () => void };

const request = (objective: string, attachments: Array<{ artifactId: string }> = []) => ({
	messages: [{ role: "user" as const, content: objective }],
	model: "m",
	conversationId: "conv-1",
	origin: "chat" as const,
	objective,
	...(attachments.length ? { attachments } : {}),
	silent: true,
});

function input(id: string, seq: number, content: string, attachments?: Array<{ artifactId: string }>) {
	return {
		id,
		runId: "parent",
		seq,
		author: "user",
		content,
		attachmentsJson: attachments ?? null,
		mode: "queue",
		status: "pending",
		clientKey: null,
		createdAt: new Date(),
		consumedAt: null,
	};
}

const record = (row: ReturnType<typeof input>): RunInputRecord => ({
	id: row.id,
	runId: row.runId,
	seq: row.seq,
	author: row.author,
	content: row.content,
	...(row.attachmentsJson ? { attachments: row.attachmentsJson } : {}),
	mode: "queue",
	status: "pending",
	clientKey: null,
	createdAt: row.createdAt.toISOString(),
	consumedAt: null,
});

const runDefaults = () => ({
	cancelRequested: false,
	jobEnqueuedAt: null,
	parentRunId: null,
	error: null,
	resultText: null,
	startedAt: null,
	finishedAt: null,
	createdAt: new Date(),
	updatedAt: new Date(),
});

beforeEach(() => {
	runs = new FakeTable(
		[{ id: "parent", userId: "u1", conversationId: "conv-1", status: "completed", cancelRequested: false }],
		runDefaults,
	);
	inputs = new FakeTable([]);
	const conversation = new FakeTable();
	conversation.findFirst = async () => ({ id: "conv-1" });
	installed = installFakes({ agentRun: runs, runInput: inputs, conversation });
});
afterEach(() => installed.restore());

const pending = () => inputs.rows.filter((row) => row.runId === "parent" && row.status === "pending");

test("W5: cria o follow-up queued (sem job) e consome os inputs juntos", async () => {
	inputs.rows = [input("i1", 1, "primeiro"), input("i2", 2, "segundo")];
	const result = await createFollowUpRun({
		parentRunId: "parent",
		userId: "u1",
		model: "m",
		request: request("primeiro\n\nsegundo"),
		consume: inputs.rows.map((row) => record(row as ReturnType<typeof input>)),
	});
	assert.equal(result.outcome, "created");
	assert.equal(pending().length, 0);
	// Sem job enfileirado: a reconciliação existente (listQueuedRunsMissingJob) o encontra.
	const missing = await listQueuedRunsMissingJob();
	assert.equal(missing.length, 1);
	assert.equal(missing[0]!.id, result.outcome === "created" ? result.run.id : "");
});

test("W5/W8: entrega duplicada → um follow-up só", async () => {
	inputs.rows = [input("i1", 1, "a")];
	const args = {
		parentRunId: "parent",
		userId: "u1",
		model: "m",
		request: request("a"),
		consume: [record(inputs.rows[0] as ReturnType<typeof input>)],
	};
	assert.equal((await createFollowUpRun(args)).outcome, "created");
	assert.equal((await createFollowUpRun(args)).outcome, "already_consumed");
	assert.equal(runs.rows.filter((row) => row.id !== "parent").length, 1);
});

test("W5/W8: crash ao criar o run desfaz o consumo; a retomada cria depois", async () => {
	inputs.rows = [input("i1", 1, "a")];
	const args = {
		parentRunId: "parent",
		userId: "u1",
		model: "m",
		request: request("a"),
		consume: [record(inputs.rows[0] as ReturnType<typeof input>)],
	};
	runs.failNextCreateWith = new Error("conexão caiu");
	await assert.rejects(createFollowUpRun(args), /conexão caiu/);
	assert.equal(pending().length, 1, "input não pode ficar consumido sem follow-up (órfão)");
	assert.equal(runs.rows.length, 1);
	assert.equal((await createFollowUpRun(args)).outcome, "created");
	assert.equal(pending().length, 0);
});

test("W5: input fora do teto de anexos vai pendente para o novo run (não é descartado)", async () => {
	const a = input("i1", 1, "", [{ artifactId: "a1" }, { artifactId: "a2" }, { artifactId: "a3" }]);
	const b = input("i2", 2, "depois", [{ artifactId: "b1" }, { artifactId: "b2" }]);
	inputs.rows = [a, b];
	const result = await createFollowUpRun({
		parentRunId: "parent",
		userId: "u1",
		model: "m",
		request: request("", a.attachmentsJson ?? []),
		consume: [record(a)],
		defer: [record(b)],
	});
	assert.equal(result.outcome, "created");
	assert.equal(pending().length, 0, "pai sem pendências");
	const moved = inputs.rows.filter((row) => row.runId !== "parent");
	assert.equal(moved.length, 1);
	assert.equal(moved[0]!.content, "depois");
	assert.deepEqual(moved[0]!.attachmentsJson, [{ artifactId: "b1" }, { artifactId: "b2" }]);
	assert.equal(moved[0]!.status, "pending");
	assert.equal(moved[0]!.runId, result.outcome === "created" ? result.run.id : "");
});

test("W5: colisão com run ativo (só imagem) vira steer nele, uma vez", async () => {
	const image = input("i1", 1, "", [{ artifactId: "img1" }]);
	inputs.rows = [image];
	runs.rows.push({ id: "active", userId: "u1", conversationId: "conv-1", status: "running", createdAt: new Date() });
	const args = {
		parentRunId: "parent",
		userId: "u1",
		model: "m",
		request: request("", [{ artifactId: "img1" }]),
		consume: [record(image)],
	};
	const conflict = Object.assign(new Error("unique"), { code: "P2002" });
	runs.failNextCreateWith = conflict;
	const result = await createFollowUpRun(args);
	assert.deepEqual(result, { outcome: "merged", runId: "active" });
	const steer = inputs.rows.filter((row) => row.runId === "active");
	assert.equal(steer.length, 1);
	assert.equal(steer[0]!.mode, "join");
	assert.equal(steer[0]!.content, "");
	assert.deepEqual(steer[0]!.attachmentsJson, [{ artifactId: "img1" }]);
	assert.equal(pending().length, 0);
	// Reentrega: já consumido, não duplica o steer.
	runs.failNextCreateWith = conflict;
	assert.equal((await createFollowUpRun(args)).outcome, "already_consumed");
	assert.equal(inputs.rows.filter((row) => row.runId === "active").length, 1);
});

test("W5: follow-up de outro dono é recusado", async () => {
	inputs.rows = [input("i1", 1, "a")];
	await assert.rejects(
		createFollowUpRun({
			parentRunId: "parent",
			userId: "u2",
			model: "m",
			request: request("a"),
			consume: [record(inputs.rows[0] as ReturnType<typeof input>)],
		}),
	);
	assert.equal(pending().length, 1);
});
