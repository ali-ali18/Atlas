/**
 * Pausa/retomada coerentes com o lease. Prisma em memória (sem banco).
 * Runner: `pnpm exec tsx --test src/run-pause.test.ts` em packages/db.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
	listQueuedRunsMissingJob,
	requestPauseAgentRun,
	requestResumeAgentRun,
	tryAcquireRunLease,
} from "./runs.js";
import { FakeTable, installFakes, type FakeRow } from "./testing/fake-tables.js";

let runs: FakeTable;
let installed: { restore: () => void };

function runRow(extra: FakeRow = {}): FakeRow {
	return {
		id: "run-1",
		status: "running",
		cancelRequested: false,
		parentRunId: null,
		leaseOwner: null,
		leaseUntil: null,
		leaseToken: null,
		leaseGeneration: 1,
		startedAt: new Date(),
		jobEnqueuedAt: new Date(),
		createdAt: new Date(),
		updatedAt: new Date(),
		...extra,
	};
}

beforeEach(() => {
	runs = new FakeTable([runRow()]);
	installed = installFakes({ agentRun: runs, agentStep: new FakeTable() });
});
afterEach(() => installed.restore());

test("pausa vale para run running e queued", async () => {
	assert.equal((await requestPauseAgentRun("run-1"))?.status, "paused");
	runs.rows[0]!.status = "queued";
	assert.equal((await requestPauseAgentRun("run-1"))?.status, "paused");
});

test("pausa em retrying não muda o run (evita órfão sem lease e sem job)", async () => {
	runs.rows[0]!.status = "retrying";
	const run = await requestPauseAgentRun("run-1");
	assert.equal(run?.status, "retrying");
	assert.equal(runs.rows[0]!.status, "retrying");
	// A próxima tentativa do BullMQ ainda adquire o lease.
	assert.ok(await tryAcquireRunLease("run-1", "worker:job:1"));
});

test("pausa em run terminal ou inexistente não altera nada", async () => {
	runs.rows[0]!.status = "completed";
	assert.equal((await requestPauseAgentRun("run-1"))?.status, "completed");
	assert.equal(await requestPauseAgentRun("nope"), null);
});

test("retomar run paused órfão (sem lease) volta para queued e o reconciliador o enxerga", async () => {
	runs.rows[0]!.status = "paused";
	const resumed = await requestResumeAgentRun("run-1");
	assert.equal(resumed?.status, "queued");
	assert.equal(runs.rows[0]!.jobEnqueuedAt, null);
	const missing = await listQueuedRunsMissingJob();
	assert.deepEqual(missing.map((row) => row.id), ["run-1"]);
	// E a próxima tentativa assume o run normalmente.
	assert.ok(await tryAcquireRunLease("run-1", "worker:job:2"));
});

test("retomar não toca run paused com lease vigente (worker ainda parando)", async () => {
	runs.rows[0]!.status = "paused";
	runs.rows[0]!.leaseOwner = "w";
	runs.rows[0]!.leaseToken = "t";
	runs.rows[0]!.leaseUntil = new Date(Date.now() + 30_000);
	assert.equal(await requestResumeAgentRun("run-1"), null);
});

test("cancelar run paused sem lease (parado num card de conexão) finaliza como cancelled", async () => {
	const { requestCancelAgentRun } = await import("./runs.js");
	runs.rows[0]!.status = "paused";
	const run = await requestCancelAgentRun("run-1");
	assert.equal(run?.status, "cancelled");
	assert.equal(runs.rows[0]!.status, "cancelled");
	assert.equal(runs.rows[0]!.cancelRequested, true);
	assert.ok(runs.rows[0]!.finishedAt instanceof Date);
	// E não dá mais para retomar.
	assert.equal(await requestResumeAgentRun("run-1"), null);
});

test("cancelar run waiting_user sem lease também finaliza", async () => {
	const { requestCancelAgentRun } = await import("./runs.js");
	runs.rows[0]!.status = "waiting_user";
	assert.equal((await requestCancelAgentRun("run-1"))?.status, "cancelled");
});

test("cancelar run paused com lease vigente deixa o worker finalizar", async () => {
	const { requestCancelAgentRun } = await import("./runs.js");
	runs.rows[0]!.status = "paused";
	runs.rows[0]!.leaseOwner = "w";
	runs.rows[0]!.leaseToken = "t";
	runs.rows[0]!.leaseUntil = new Date(Date.now() + 30_000);
	const run = await requestCancelAgentRun("run-1");
	assert.equal(run?.status, "paused");
	assert.equal(runs.rows[0]!.cancelRequested, true);
	assert.equal(runs.rows[0]!.leaseOwner, "w");
});

test("listRunsAwaitingConnector acha só runs pausados do dono parados naquele conector", async () => {
	const { listRunsAwaitingConnector } = await import("./runs.js");
	const pending = (id: string) => ({ pendingLogin: { loginId: "l", site: "x", url: "u", connector: { kind: "native", id } } });
	runs.rows[0] = runRow({ id: "a", userId: "u1", status: "paused", checkpointJson: pending("google_calendar") });
	runs.rows.push(runRow({ id: "b", userId: "u1", status: "paused", checkpointJson: pending("gmail") }));
	runs.rows.push(runRow({ id: "c", userId: "u2", status: "paused", checkpointJson: pending("google_calendar") }));
	runs.rows.push(runRow({ id: "d", userId: "u1", status: "running", checkpointJson: pending("google_calendar") }));
	assert.deepEqual(await listRunsAwaitingConnector("u1", "google_calendar"), ["a"]);
});
