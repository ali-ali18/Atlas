/**
 * Motivo de término do run (F0 do ADR 0002) contra Postgres real. Pulado sem ATLAS_TEST_DB_URL.
 * Runner: `pnpm --filter @workspace/db test:db`.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { prisma } from "./client.js";
import { completeAgentRunAtomically, failAgentRunAfterRetries, failStaleRunningRuns, finishAgentRun } from "./runs.js";
import { finishSubagentRun } from "./subagent-runs.js";
import { createTestBot, createTestUser, dbSkip } from "./testing/test-db.js";

describe("stopReason/stopDetail (Postgres real)", { skip: dbSkip }, () => {
	let userId: string;
	let otherId: string;
	let botId: string;

	before(async () => {
		userId = (await createTestUser("stop")).id;
		otherId = (await createTestUser("stop-other")).id;
		botId = (await createTestBot(userId)).id;
	});
	after(async () => {
		await prisma.$disconnect();
	});

	const newRun = (over: Record<string, unknown> = {}) =>
		prisma.agentRun.create({ data: { userId, botId, objective: "o", model: "m", status: "running", ...over } });
	const read = (id: string) => prisma.agentRun.findUniqueOrThrow({ where: { id }, select: { status: true, stopReason: true, stopDetail: true } });

	test("run novo nasce sem motivo (colunas anuláveis)", async () => {
		const run = await newRun();
		assert.deepEqual(await read(run.id), { status: "running", stopReason: null, stopDetail: null });
	});

	test("finishAgentRun grava motivo e detalhe saneado", async () => {
		const run = await newRun();
		await finishAgentRun(run.id, { status: "budget_exhausted", error: "limite", stop: { reason: "budget_wall", detail: "Bearer sk-SEGREDO texto longo!" } });
		const row = await read(run.id);
		assert.equal(row.stopReason, "budget_wall");
		assert.match(row.stopDetail ?? "", /^[a-z0-9_.:-]+$/);
	});

	test("finishAgentRun sem stop não toca nas colunas", async () => {
		const run = await newRun({ stopReason: "answered" });
		await finishAgentRun(run.id, { status: "failed", error: "x" });
		assert.equal((await read(run.id)).stopReason, "answered");
	});

	test("completeAgentRunAtomically grava o motivo da conclusão", async () => {
		const run = await newRun();
		await completeAgentRunAtomically({
			runId: run.id,
			assistantText: "feito",
			donePayload: { type: "done", message: { role: "assistant", content: "feito" }, model: "m" },
			stop: { reason: "awaiting_confirmation", detail: "confirm" },
		});
		assert.deepEqual(await read(run.id), { status: "completed", stopReason: "awaiting_confirmation", stopDetail: "confirm" });
	});

	test("retries esgotados e worker sem heartbeat têm motivo próprio", async () => {
		const failed = await newRun({ status: "retrying" });
		assert.equal(await failAgentRunAfterRetries(failed.id, "Falha após 3 tentativas: x"), true);
		assert.equal((await read(failed.id)).stopReason, "retries_exhausted");

		const stale = await newRun({ status: "running" });
		await prisma.$executeRaw`UPDATE agent_runs SET "updatedAt" = now() - interval '2 hours' WHERE id = ${stale.id}`;
		const ids = await failStaleRunningRuns(60_000, 50);
		assert.ok(ids.includes(stale.id));
		assert.deepEqual(await read(stale.id), { status: "failed", stopReason: "crash_recoveries", stopDetail: "no_heartbeat" });
	});

	test("subagente: outro usuário não altera o motivo do run alheio", async () => {
		const child = await newRun({ origin: "subagent" });
		const denied = await finishSubagentRun({ runId: child.id, userId: otherId, status: "failed", stop: { reason: "error" } });
		assert.equal(denied, false);
		assert.equal((await read(child.id)).stopReason, null);
		const ok = await finishSubagentRun({ runId: child.id, userId, status: "completed", stop: { reason: "answered" } });
		assert.equal(ok, true);
		assert.equal((await read(child.id)).stopReason, "answered");
	});
});
