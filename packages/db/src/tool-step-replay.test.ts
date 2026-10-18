/**
 * W9/L20 — replay de tool e intenção sem resultado. Prisma stubado (sem
 * banco). Runner: `pnpm exec tsx --test src/tool-step-replay.test.ts` em
 * packages/db.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { prisma } from "./client.js";
import { findCompletedToolStep, findStartedToolStep } from "./runs.js";

type Row = {
	idempotencyKey: string;
	status: string;
	inputJson?: unknown;
	outputJson?: unknown;
};
const agentStep = prisma.agentStep as unknown as Record<string, unknown>;
const original = agentStep.findFirst;

afterEach(() => {
	agentStep.findFirst = original;
});

function stub(rows: Row[]) {
	agentStep.findFirst = async ({
		where,
	}: {
		where: { idempotencyKey: string; status: string | { in: string[] } };
	}) =>
		rows.find((row) => {
			if (row.idempotencyKey !== where.idempotencyKey) return false;
			return typeof where.status === "string"
				? row.status === where.status
				: where.status.in.includes(row.status);
		}) ?? null;
}

test("passo concluído devolve o status estruturado e o card de arquivo", async () => {
	const file = { type: "file", artifactId: "a1", filename: "r.pdf", mime: "application/pdf", size: 10, format: "pdf", version: 1 };
	stub([
		{
			idempotencyKey: "k1",
			status: "completed",
			outputJson: { summary: "File created", ok: true, status: { status: "ok", effect: "applied" }, file },
		},
	]);
	const replay = await findCompletedToolStep("r", "k1");
	assert.equal(replay?.ok, true);
	assert.deepEqual(replay?.status, { status: "ok", effect: "applied" });
	assert.equal(replay?.file?.artifactId, "a1");
});

test("passo antigo (sem status) continua sendo reaproveitado", async () => {
	stub([{ idempotencyKey: "k1", status: "completed", outputJson: { summary: "done", ok: true } }]);
	const replay = await findCompletedToolStep("r", "k1");
	assert.equal(replay?.summary, "done");
	assert.equal(replay?.status, undefined);
});

test("falha comum não é replay: a tool pode ser reexecutada", async () => {
	stub([
		{
			idempotencyKey: "k1",
			status: "failed",
			outputJson: { summary: "boom", ok: false, status: { status: "error", effect: "none" } },
		},
	]);
	assert.equal(await findCompletedToolStep("r", "k1"), null);
	stub([{ idempotencyKey: "k1", status: "failed", outputJson: { summary: "boom", ok: false } }]);
	assert.equal(await findCompletedToolStep("r", "k1"), null);
});

test("falha de efeito incerto É replay: a escrita não se repete", async () => {
	stub([
		{
			idempotencyKey: "k1",
			status: "failed",
			outputJson: { summary: "timed out", ok: false, status: { status: "uncertain", effect: "uncertain", code: "timeout" } },
		},
	]);
	const replay = await findCompletedToolStep("r", "k1");
	assert.equal(replay?.ok, false);
	assert.equal(replay?.status?.effect, "uncertain");
});

test("findStartedToolStep: só intenção gravada (attemptId) sem resultado", async () => {
	stub([
		{ idempotencyKey: "w1", status: "running", inputJson: { name: "write_tool", args: {}, attemptId: "w1" } },
		{ idempotencyKey: "r1", status: "running", inputJson: { name: "read_tool", args: {} } },
		{ idempotencyKey: "d1", status: "completed", inputJson: { name: "write_tool", attemptId: "d1" } },
	]);
	assert.deepEqual(await findStartedToolStep("r", "w1"), { attemptId: "w1", tool: "write_tool" });
	assert.equal(await findStartedToolStep("r", "r1"), null);
	assert.equal(await findStartedToolStep("r", "d1"), null);
	assert.equal(await findStartedToolStep("r", "missing"), null);
});
