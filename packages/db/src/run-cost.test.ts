/**
 * Reconciliação de custo no db: escopo por dono, idempotência e soma no
 * usageJson. Prisma stubado (sem banco). Runner:
 * `pnpm exec tsx --test src/run-cost.test.ts` em packages/db.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { prisma } from "./client.js";
import { addLateRunUsage, applyReconciledStepCost, listStepsMissingCost } from "./run-cost.js";

const db = prisma as unknown as Record<string, Record<string, unknown> | unknown>;
const originals = { tx: db.$transaction, step: { ...(db.agentStep as object) }, run: { ...(db.agentRun as object) } };
afterEach(() => {
	db.$transaction = originals.tx;
	Object.assign(db.agentStep as object, originals.step);
	Object.assign(db.agentRun as object, originals.run);
});

function stubDb(owner: string) {
	const step = { id: "s1", runId: "r1", costUsd: null as number | null, outputJson: { content: "x", telemetry: { v: 1, generationId: "gen-1" } } as unknown };
	const run = { id: "r1", userId: owner, usageJson: { promptTokens: 1, costUsd: 0.1, costUnknownCalls: 2 } as unknown };
	const tx = {
		agentStep: {
			findFirst: async ({ where }: { where: { id: string; run?: { userId: string }; costUsd: null } }) =>
				where.id === step.id && step.costUsd === null && (!where.run || where.run.userId === run.userId) ? step : null,
			updateMany: async ({ where, data }: { where: { id: string; costUsd: null }; data: { costUsd: number; outputJson: unknown } }) => {
				if (where.id !== step.id || step.costUsd !== null) return { count: 0 };
				step.costUsd = data.costUsd;
				step.outputJson = data.outputJson;
				return { count: 1 };
			},
		},
		agentRun: {
			findFirst: async ({ where }: { where: { userId: string } }) => (where.userId === run.userId ? run : null),
			updateMany: async ({ where, data }: { where: { userId: string }; data: { usageJson: unknown } }) => {
				if (where.userId !== run.userId) return { count: 0 };
				run.usageJson = data.usageJson;
				return { count: 1 };
			},
		},
	};
	db.$transaction = async (fn: (t: unknown) => unknown) => fn(tx);
	return { step, run };
}

test("aplica o custo no passo e no run (soma e decrementa costUnknownCalls)", async () => {
	const { step, run } = stubDb("owner");
	assert.equal(await applyReconciledStepCost({ runId: "r1", userId: "owner", stepId: "s1", costUsd: 0.05 }), true);
	assert.equal(step.costUsd, 0.05);
	assert.deepEqual((step.outputJson as { telemetry: unknown }).telemetry, { v: 1, generationId: "gen-1", costUsd: 0.05, costReconciled: true });
	const usage = run.usageJson as { costUsd: number; costUnknownCalls: number };
	assert.ok(Math.abs(usage.costUsd - 0.15) < 1e-9);
	assert.equal(usage.costUnknownCalls, 1);
});

test("idempotente: a segunda aplicação não soma de novo", async () => {
	const { run } = stubDb("owner");
	await applyReconciledStepCost({ runId: "r1", userId: "owner", stepId: "s1", costUsd: 0.05 });
	assert.equal(await applyReconciledStepCost({ runId: "r1", userId: "owner", stepId: "s1", costUsd: 0.05 }), false);
	assert.equal((run.usageJson as { costUnknownCalls: number }).costUnknownCalls, 1);
});

test("outro usuário não altera o passo nem o run", async () => {
	const { step, run } = stubDb("owner");
	assert.equal(await applyReconciledStepCost({ runId: "r1", userId: "intruso", stepId: "s1", costUsd: 9 }), false);
	assert.equal(step.costUsd, null);
	assert.equal((run.usageJson as { costUsd: number }).costUsd, 0.1);
});

test("custo inválido é recusado", async () => {
	stubDb("owner");
	assert.equal(await applyReconciledStepCost({ runId: "r1", userId: "owner", stepId: "s1", costUsd: -1 }), false);
	assert.equal(await applyReconciledStepCost({ runId: "r1", userId: "owner", stepId: "s1", costUsd: Number.NaN }), false);
});

test("listStepsMissingCost filtra pelo dono, exige generationId e respeita o limite", async () => {
	let where: unknown;
	(db.agentStep as Record<string, unknown>).findMany = async (args: { where: unknown }) => {
		where = args.where;
		return [
			{ id: "a", outputJson: { telemetry: { v: 1, generationId: "g-a" } } },
			{ id: "b", outputJson: { telemetry: { v: 1 } } },
			{ id: "c", outputJson: { telemetry: { v: 1, generationId: "g-c" } } },
			{ id: "d", outputJson: { telemetry: { v: 1, generationId: "g-d" } } },
		];
	};
	const out = await listStepsMissingCost({ runId: "r1", userId: "owner", limit: 2 });
	assert.deepEqual(out, [{ stepId: "a", generationId: "g-a" }, { stepId: "c", generationId: "g-c" }]);
	assert.deepEqual(where, { runId: "r1", run: { userId: "owner" }, type: "model", costUsd: null });
});

test("custo de chamada do plano nunca é reconciliado como USD", async () => {
 const { step } = stubDb("owner"); step.outputJson = { telemetry: { v: 1, generationId: "fixture", provider: "chatgpt", costKind: "plan" } };
 assert.equal(await applyReconciledStepCost({ runId: "r1", userId: "owner", stepId: "s1", costUsd: 10 }), false); assert.equal(step.costUsd, null);
 const original = prisma.agentStep.findMany; Reflect.set(prisma.agentStep, "findMany", async () => [step]);
 try { assert.deepEqual(await listStepsMissingCost({ runId: "r1", userId: "owner", limit: 20 }), []); } finally { Reflect.set(prisma.agentStep, "findMany", original); }
});

test("addLateRunUsage soma o uso tardio e troca a telemetria no run do dono", async () => {
	const { run } = stubDb("owner");
	const ok = await addLateRunUsage({
		runId: "r1",
		userId: "owner",
		usage: { promptTokens: 10, totalTokens: 10, costUsd: 0.002 },
		telemetry: { v: 1, setupMs: 3 },
	});
	assert.equal(ok, true);
	const usage = run.usageJson as { promptTokens: number; costUsd: number; costUnknownCalls: number; telemetry: unknown };
	assert.equal(usage.promptTokens, 11);
	assert.ok(Math.abs(usage.costUsd - 0.102) < 1e-9);
	assert.equal(usage.costUnknownCalls, 2);
	assert.deepEqual(usage.telemetry, { v: 1, setupMs: 3 });
});

test("addLateRunUsage: outro usuário não altera o run", async () => {
	const { run } = stubDb("owner");
	assert.equal(await addLateRunUsage({ runId: "r1", userId: "intruso", usage: { costUsd: 5 } }), false);
	assert.deepEqual(run.usageJson, { promptTokens: 1, costUsd: 0.1, costUnknownCalls: 2 });
});

test("addLateRunUsage sem nada a somar não toca no banco", async () => {
	stubDb("owner");
	db.$transaction = async () => {
		throw new Error("não deveria abrir transação");
	};
	assert.equal(await addLateRunUsage({ runId: "r1", userId: "owner", usage: null }), false);
});
