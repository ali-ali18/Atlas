/**
 * F0 — passos do run: durationMs/costUsd persistidos e `attempts` só conta
 * retry real. Prisma stubado (sem banco). Runner:
 * `pnpm exec tsx --test src/agent-step.test.ts` em packages/db.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { prisma } from "./client.js";
import { appendAgentStep, isRealStepRetry } from "./runs.js";

type Row = Record<string, unknown> & { id: string };
const agentStep = prisma.agentStep as unknown as Record<string, unknown>;
const client = prisma as unknown as Record<string, unknown>;
const originals = {
	$executeRaw: client.$executeRaw,
	findFirst: agentStep.findFirst,
	findUnique: agentStep.findUnique,
	update: agentStep.update,
	upsert: agentStep.upsert,
};

afterEach(() => {
	const { $executeRaw, ...model } = originals;
	Object.assign(agentStep, model);
	client.$executeRaw = $executeRaw;
});

/** Captura o INSERT ... ON CONFLICT (template tag) sem banco. */
function captureRaw(failWith?: Error) {
	const calls: Array<{ sql: string; values: unknown[] }> = [];
	client.$executeRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
		calls.push({ sql: strings.join("?"), values });
		if (failWith) throw failWith;
		return 1;
	};
	return calls;
}

/** Simula chave de idempotência em outra posição: o upsert falha e cai na busca. */
function forceLookupPath() {
	return captureRaw(new Error("duplicate key value violates unique constraint (23505)"));
}

function stub(rows: Row[]) {
	forceLookupPath();
	const updates: Array<Record<string, unknown>> = [];
	const upserts: Array<Record<string, unknown>> = [];
	agentStep.findFirst = async ({ where }: { where: { idempotencyKey?: string } }) =>
		rows.find((row) => row.idempotencyKey === where.idempotencyKey) ?? null;
	agentStep.findUnique = async () => rows[0] ?? null;
	agentStep.update = async (args: { data: Record<string, unknown> }) => {
		updates.push(args.data);
		return {};
	};
	agentStep.upsert = async (args: Record<string, unknown>) => {
		upserts.push(args);
		return {};
	};
	return { updates, upserts };
}

test("isRealStepRetry: só o mesmo type conta como tentativa", () => {
	assert.equal(isRealStepRetry(null, { type: "tool" }), false);
	assert.equal(isRealStepRetry({ type: "tool" }, { type: "tool_result" }), false);
	assert.equal(isRealStepRetry({ type: "tool" }, { type: "tool" }), true);
	assert.equal(isRealStepRetry({ type: "model" }, { type: "model" }), true);
});

test("tool → tool_result na mesma chave NÃO incrementa attempts e grava durationMs", async () => {
	const { updates } = stub([{ id: "s1", type: "tool", idempotencyKey: "k1" }]);
	await appendAgentStep({
		runId: "r1",
		decisionIndex: 0,
		subIndex: 1,
		type: "tool_result",
		status: "completed",
		idempotencyKey: "k1",
		durationMs: 1234.6,
		outputJson: { summary: "ok", telemetry: { v: 1, toolMs: 1235 } },
	});
	assert.equal(updates.length, 1);
	assert.equal(updates[0]!.durationMs, 1235);
	assert.equal("attempts" in updates[0]!, false);
});

test("replay do mesmo type (retry real) incrementa attempts", async () => {
	const { updates } = stub([{ id: "s1", type: "model", idempotencyKey: "k2" }]);
	await appendAgentStep({
		runId: "r1",
		decisionIndex: 1,
		subIndex: 0,
		type: "model",
		idempotencyKey: "k2",
		durationMs: 500,
		costUsd: 0.003,
	});
	assert.deepEqual(updates[0]!.attempts, { increment: 1 });
	assert.equal(updates[0]!.costUsd, 0.003);
});

test("sem chave: reescrever o mesmo índice com outro type não conta tentativa", async () => {
	const { updates } = stub([{ id: "s9", type: "tool" }]);
	await appendAgentStep({ runId: "r1", decisionIndex: 2, subIndex: 1, type: "tool_result" });
	assert.equal("attempts" in updates[0]!, false);
});

test("passo novo vai pelo upsert com durationMs e custo ausente (não zero)", async () => {
	const { upserts } = stub([]);
	await appendAgentStep({
		runId: "r1",
		decisionIndex: 0,
		subIndex: 0,
		type: "model",
		idempotencyKey: "k3",
		durationMs: 900,
	});
	const create = (upserts[0] as { create: Record<string, unknown> }).create;
	assert.equal(create.durationMs, 900);
	assert.equal(create.costUsd, undefined);
});

function stubNoRaw() {
	const updates: Array<Record<string, unknown>> = [];
	const upserts: Array<Record<string, unknown>> = [];
	agentStep.findFirst = async () => null;
	agentStep.findUnique = async () => null;
	agentStep.update = async (args: { data: Record<string, unknown> }) => {
		updates.push(args.data);
		return {};
	};
	agentStep.upsert = async (args: Record<string, unknown>) => {
		upserts.push(args);
		return {};
	};
	return { updates, upserts };
}

test("L10: passo vai em UM INSERT ... ON CONFLICT, sem find nem update", async () => {
	const calls = captureRaw();
	const { updates, upserts } = stubNoRaw();
	await appendAgentStep({
		runId: "r1",
		decisionIndex: 3,
		subIndex: 1,
		type: "tool_result",
		idempotencyKey: "k4",
		durationMs: 12.4,
		outputJson: { ok: true },
	});
	assert.equal(calls.length, 1);
	assert.match(calls[0]!.sql, /INSERT INTO "agent_steps"/);
	assert.match(calls[0]!.sql, /ON CONFLICT \("runId", "decisionIndex", "subIndex"\) DO UPDATE/);
	// retry real (mesmo type) incrementa; tool -> tool_result não.
	assert.match(calls[0]!.sql, /CASE WHEN "agent_steps"\."type" = EXCLUDED\."type"/);
	assert.ok(calls[0]!.values.includes(301), "index = decisionIndex*100+subIndex");
	assert.ok(calls[0]!.values.includes("k4"));
	assert.ok(calls[0]!.values.includes(12));
	assert.ok(calls[0]!.values.includes('{"ok":true}'));
	assert.equal(updates.length + upserts.length, 0);
});

test("L10: campos ausentes vão como NULL (COALESCE preserva o já gravado)", async () => {
	const calls = captureRaw();
	await appendAgentStep({ runId: "r1", decisionIndex: 0, subIndex: 0, type: "model" });
	const nulls = calls[0]!.values.filter((value) => value === null).length;
	assert.equal(nulls, 6, "inputJson, outputJson, key, duration, tokens, cost");
	assert.match(calls[0]!.sql, /COALESCE\(EXCLUDED\."outputJson"/);
});

test("L10: erro que não é de unicidade não cai no caminho por busca", async () => {
	captureRaw(new Error("connection reset"));
	const { updates, upserts } = stubNoRaw();
	await assert.rejects(
		appendAgentStep({ runId: "r1", decisionIndex: 0, subIndex: 0, type: "model" }),
		/connection reset/,
	);
	assert.equal(updates.length + upserts.length, 0);
});
