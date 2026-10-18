/**
 * V2 — entrada do usuário que ficou pendente quando o run terminou (parada,
 * falha). O varredor lista só run terminal com entrada promovível, e a
 * promoção (`createFollowUpRun`) é exatamente uma vez e do mesmo dono.
 * Runner: `pnpm exec tsx --test src/orphan-inputs.test.ts` em packages/db.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { RunInputRecord } from "@workspace/shared";
import { createFollowUpRun, listTerminalRunsWithPendingInputs } from "./runs.js";
import { FakeTable, installFakes } from "./testing/fake-tables.js";

let runs: FakeTable;
let inputs: FakeTable;
let installed: { restore: () => void };

const old = () => new Date(Date.now() - 120_000);

const run = (id: string, userId: string, status: string) => ({
	id,
	userId,
	conversationId: `conv-${id}`,
	status,
	cancelRequested: status === "cancelled",
	createdAt: old(),
	updatedAt: old(),
});

const input = (id: string, runId: string, mode: string, createdAt = old()) => ({
	id,
	runId,
	seq: 1,
	author: "user",
	content: `msg ${id}`,
	attachmentsJson: null,
	mode,
	status: "pending",
	clientKey: null,
	createdAt,
	consumedAt: null,
});

const record = (row: ReturnType<typeof input>): RunInputRecord => ({
	id: row.id,
	runId: row.runId,
	seq: row.seq,
	author: row.author,
	content: row.content,
	mode: row.mode as RunInputRecord["mode"],
	status: "pending",
	clientKey: null,
	createdAt: row.createdAt.toISOString(),
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
	}));
	inputs = new FakeTable([]);
	const conversation = new FakeTable();
	conversation.findFirst = async () => ({ id: "conv" });
	installed = installFakes({ agentRun: runs, runInput: inputs, conversation });
});
afterEach(() => installed.restore());

test("lista run cancelado com join pendente (o caso real do join órfão)", async () => {
	runs.rows = [run("r-cancelled", "u1", "cancelled")];
	inputs.rows = [input("i1", "r-cancelled", "join")];
	const found = await listTerminalRunsWithPendingInputs();
	assert.deepEqual(found.map((item) => item.id), ["r-cancelled"]);
});

test("ignora run ativo, entrada de parada (cancel), entrada recente e já consumida", async () => {
	runs.rows = [
		run("active", "u1", "running"),
		run("stopped", "u1", "cancelled"),
		run("fresh", "u1", "cancelled"),
		run("done", "u1", "failed"),
	];
	inputs.rows = [
		input("a", "active", "join"),
		input("b", "stopped", "cancel"),
		input("c", "fresh", "join", new Date()),
		{ ...input("d", "done", "join"), status: "consumed" },
	];
	assert.deepEqual(await listTerminalRunsWithPendingInputs(), []);
});

test("promove uma vez só: a reentrega e o varredor não duplicam o turno", async () => {
	runs.rows = [run("r1", "u1", "cancelled")];
	inputs.rows = [input("i1", "r1", "join")];
	const args = {
		parentRunId: "r1",
		userId: "u1",
		model: "m",
		request: {
			messages: [{ role: "user" as const, content: "msg i1" }],
			model: "m",
			conversationId: "conv-r1",
			origin: "chat" as const,
			objective: "msg i1",
			silent: true,
		},
		consume: [record(inputs.rows[0] as ReturnType<typeof input>)],
	};
	assert.equal((await createFollowUpRun(args)).outcome, "created");
	assert.equal((await createFollowUpRun(args)).outcome, "already_consumed");
	assert.equal(runs.rows.filter((row) => row.id !== "r1").length, 1);
	assert.deepEqual(await listTerminalRunsWithPendingInputs(), []);
});

test("usuário B não promove a entrada de run do usuário A", async () => {
	runs.rows = [run("r1", "u1", "cancelled")];
	inputs.rows = [input("i1", "r1", "join")];
	await assert.rejects(
		createFollowUpRun({
			parentRunId: "r1",
			userId: "u2",
			model: "m",
			request: {
				messages: [{ role: "user", content: "x" }],
				model: "m",
				conversationId: "conv-r1",
				origin: "chat",
				objective: "x",
				silent: true,
			},
			consume: [record(inputs.rows[0] as ReturnType<typeof input>)],
		}),
	);
	assert.equal(inputs.rows[0]!.status, "pending");
	assert.equal(runs.rows.length, 1);
});
