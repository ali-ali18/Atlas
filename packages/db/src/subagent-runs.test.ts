/**
 * F5 — runs filhos: escopo por dono e profundidade 1. Prisma stubado (sem
 * banco). Runner: `pnpm exec tsx --test src/subagent-runs.test.ts` em packages/db.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { prisma } from "./client.js";
import {
	createSubagentRun,
	failOrphanSubagentRuns,
	finishSubagentRun,
	listSubagentRuns,
} from "./subagent-runs.js";

type Rows = Array<Record<string, unknown>>;
const agentRun = prisma.agentRun as unknown as Record<string, unknown>;
const originals = {
	findFirst: agentRun.findFirst,
	create: agentRun.create,
	updateMany: agentRun.updateMany,
	findMany: agentRun.findMany,
	findUnique: agentRun.findUnique,
	update: agentRun.update,
};

function matches(row: Record<string, unknown>, where: Record<string, unknown>) {
	return Object.entries(where).every(([key, expected]) =>
		typeof expected === "object" && expected !== null
			? true
			: row[key] === expected,
	);
}

function stubDb(table: Rows) {
	const created: Rows = [];
	agentRun.findFirst = async ({ where }: { where: Record<string, unknown> }) =>
		table.find((row) => matches(row, where)) ?? null;
	agentRun.create = async ({ data }: { data: Record<string, unknown> }) => {
		created.push(data);
		return { id: "child-1" };
	};
	agentRun.updateMany = async ({ where }: { where: Record<string, unknown> }) => ({
		count: table.filter((row) => matches(row, where)).length,
	});
	agentRun.findMany = async ({ where }: { where: Record<string, unknown> }) =>
		table.filter((row) => matches(row, where));
	return created;
}

afterEach(() => {
	Object.assign(agentRun, originals);
});

const parentA = { id: "run-a", userId: "user-a", botId: "bot-a", parentRunId: null, origin: "chat" };

test("createSubagentRun herda dono e bot do pai lido no banco", async () => {
	const created = stubDb([parentA]);
	const child = await createSubagentRun({
		parentRunId: "run-a",
		userId: "user-a",
		goal: "pesquisar preço",
		model: "m",
		maxSteps: 30,
	});
	assert.deepEqual(child, { id: "child-1" });
	assert.equal(created[0]?.userId, "user-a");
	assert.equal(created[0]?.botId, "bot-a");
	assert.equal(created[0]?.parentRunId, "run-a");
	assert.equal(created[0]?.origin, "subagent");
	assert.equal(created[0]?.conversationId, null);
});

test("createSubagentRun: usuário B não abre filho no run do usuário A", async () => {
	const created = stubDb([parentA]);
	const child = await createSubagentRun({
		parentRunId: "run-a",
		userId: "user-b",
		goal: "x",
		model: "m",
		maxSteps: 30,
	});
	assert.equal(child, null);
	assert.equal(created.length, 0);
});

test("createSubagentRun: filho não cria filho (profundidade 1)", async () => {
	const created = stubDb([{ ...parentA, id: "child-x", parentRunId: "run-a", origin: "subagent" }]);
	const child = await createSubagentRun({
		parentRunId: "child-x",
		userId: "user-a",
		goal: "x",
		model: "m",
		maxSteps: 30,
	});
	assert.equal(child, null);
	assert.equal(created.length, 0);
});

test("listSubagentRuns / finish / failOrphan: usuário B não lê nem altera filhos de A", async () => {
	stubDb([
		{ id: "c1", userId: "user-a", parentRunId: "run-a", origin: "subagent", status: "running" },
	]);
	assert.equal((await listSubagentRuns("run-a", "user-a")).length, 1);
	assert.equal((await listSubagentRuns("run-a", "user-b")).length, 0);
	assert.equal(
		await finishSubagentRun({ runId: "c1", userId: "user-b", status: "completed" }),
		false,
	);
	assert.equal(
		await finishSubagentRun({ runId: "c1", userId: "user-a", status: "completed" }),
		true,
	);
	assert.equal(await failOrphanSubagentRuns("run-a", "user-b"), 0);
	assert.equal(await failOrphanSubagentRuns("run-a", "user-a"), 1);
});

test("recoverStaleRunningRuns nunca re-enfileira filho de subagente; cancelar o pai marca os filhos", async () => {
	const { recoverStaleRunningRuns, requestCancelAgentRun } = await import("./runs.js");
	const wheres: Array<Record<string, unknown>> = [];
	const updates: Array<Record<string, unknown>> = [];
	agentRun.findMany = async ({ where }: { where: Record<string, unknown> }) => {
		wheres.push(where);
		return [];
	};
	await recoverStaleRunningRuns();
	assert.equal(wheres[0]?.parentRunId, null);

	agentRun.findUnique = async () => ({ id: "run-a", status: "running", finishedAt: null });
	agentRun.update = async () => ({
		id: "run-a", userId: "user-a", botId: null, conversationId: null, origin: "chat", objective: "x",
		status: "running", model: "m", maxSteps: 1, sandboxSessionId: null, error: null, resultText: null,
		cancelRequested: true, createdAt: new Date(), updatedAt: new Date(), startedAt: null, finishedAt: null,
	});
	agentRun.updateMany = async (arg: Record<string, unknown>) => {
		updates.push(arg);
		return { count: 1 };
	};
	await requestCancelAgentRun("run-a");
	assert.equal((updates[0]?.where as Record<string, unknown>).parentRunId, "run-a");
	assert.deepEqual(updates[0]?.data, { cancelRequested: true });
});
