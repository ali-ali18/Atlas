/**
 * F2 (W1/W2/W8) — identidade e fencing do lease do run. Prisma em memória
 * (sem banco). Runner: `pnpm exec tsx --test src/run-lease.test.ts` em packages/db.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
	appendAgentStep,
	assertRunLease,
	cancelStaleCancelledRuns,
	failStaleRunningRuns,
	finishAgentRun,
	persistRunProgress,
	recoverStaleRunningRuns,
	renewRunLease,
	setRunSandboxSession,
	tryAcquireRunLease,
} from "./runs.js";
import { prisma } from "./client.js";
import { FakeTable, installFakes, type FakeRow } from "./testing/fake-tables.js";

const MIN = 60_000;
let runs: FakeTable;
let steps: FakeTable;
let installed: { restore: () => void };

const ago = (ms: number) => new Date(Date.now() - ms);
const ahead = (ms: number) => new Date(Date.now() + ms);

function runRow(extra: FakeRow = {}): FakeRow {
	return {
		id: "run-1",
		status: "queued",
		cancelRequested: false,
		parentRunId: null,
		leaseOwner: null,
		leaseUntil: null,
		leaseToken: null,
		leaseGeneration: 0,
		startedAt: null,
		jobEnqueuedAt: new Date(),
		updatedAt: ago(60 * MIN),
		...extra,
	};
}

beforeEach(() => {
	runs = new FakeTable([runRow()]);
	steps = new FakeTable();
	installed = installFakes({ agentRun: runs, agentStep: steps });
});
afterEach(() => installed.restore());

test("W1: reentrega com lease vigente não assume o run (nem o mesmo processo)", async () => {
	const first = await tryAcquireRunLease("run-1", "worker-a:job-1:uuid-1");
	assert.ok(first);
	// Outra tentativa do MESMO worker/job: owner diferente por execução.
	assert.equal(await tryAcquireRunLease("run-1", "worker-a:job-1:uuid-2"), null);
	// Nem o mesmo owner re-adquire: o lease pertence à execução, não ao processo.
	assert.equal(await tryAcquireRunLease("run-1", "worker-a:job-1:uuid-1"), null);
	assert.equal(runs.rows[0]!.leaseToken, first.token);
});

test("W1: lease vencido pode ser assumido por nova tentativa", async () => {
	const first = await tryAcquireRunLease("run-1", "worker-a:job-1:uuid-1");
	assert.ok(first);
	runs.rows[0]!.leaseUntil = ago(1000);
	const second = await tryAcquireRunLease("run-1", "worker-a:job-1:uuid-2");
	assert.ok(second);
	assert.notEqual(second.token, first.token);
	// A execução antiga não renova nem escreve mais.
	assert.equal(await renewRunLease("run-1", first.owner, first.token), false);
});

test("W2: renew só renova lease vigente", async () => {
	const lease = await tryAcquireRunLease("run-1", "o1");
	assert.ok(lease);
	assert.equal(await renewRunLease("run-1", lease.owner, lease.token), true);
	runs.rows[0]!.leaseUntil = ago(1);
	assert.equal(await renewRunLease("run-1", lease.owner, lease.token), false);
	assert.ok((runs.rows[0]!.leaseUntil as Date).getTime() < Date.now());
});

test("W2: assert, progresso, finish e step recusam lease vencido", async () => {
	const lease = await tryAcquireRunLease("run-1", "o1");
	assert.ok(lease);
	await assertRunLease("run-1", lease.owner, lease.token);
	runs.rows[0]!.leaseUntil = ago(1);
	await assert.rejects(assertRunLease("run-1", lease.owner, lease.token), /lease_lost/);
	await assert.rejects(
		persistRunProgress({
			runId: "run-1",
			checkpoint: { version: 2, messages: [], nextStepIndex: 0, consumedInputIds: [] },
			lease,
		}),
		/lease_lost/,
	);
	await assert.rejects(finishAgentRun("run-1", { status: "failed", lease }), /lease_lost/);
	await assert.rejects(
		appendAgentStep({ runId: "run-1", decisionIndex: 0, subIndex: 0, type: "model", lease }),
		/lease_lost/,
	);
	assert.equal(steps.rows.length, 0);
	assert.equal(runs.rows[0]!.status, "running");
});

/** Emula o INSERT ... ON CONFLICT do passo na tabela em memória (mesma regra de `attempts`). */
function emulateStepUpsert() {
	const client = prisma as unknown as Record<string, unknown>;
	client.$executeRaw = async (_sql: TemplateStringsArray, ...v: unknown[]) => {
		const [, runId, , decisionIndex, subIndex, type, status] = v as [string, string, number, number, number, string, string];
		const existing = steps.rows.find(
			(row) => row.runId === runId && row.decisionIndex === decisionIndex && row.subIndex === subIndex,
		);
		if (existing) {
			if (existing.type === type) existing.attempts = ((existing.attempts as number | undefined) ?? 1) + 1;
			Object.assign(existing, { type, status });
		} else {
			steps.rows.push({ id: String(v[0]), runId, decisionIndex, subIndex, type, status });
		}
		return 1;
	};
}

test("W2: appendAgentStep com lease vigente grava e mantém isRealStepRetry", async () => {
	const lease = await tryAcquireRunLease("run-1", "o1");
	assert.ok(lease);
	emulateStepUpsert();
	const base = { runId: "run-1", decisionIndex: 1, subIndex: 0, lease, idempotencyKey: "k" };
	await appendAgentStep({ ...base, type: "tool" });
	await appendAgentStep({ ...base, type: "tool_result" });
	assert.equal(steps.rows.length, 1);
	assert.equal(steps.rows[0]!.attempts, undefined, "tool → tool_result não é retry");
	await appendAgentStep({ ...base, type: "tool_result" });
	assert.equal(steps.rows[0]!.attempts, 2, "mesmo tipo repetido é retry real");
});

test("W2: appendAgentStep respeita cancelamento pedido", async () => {
	const lease = await tryAcquireRunLease("run-1", "o1");
	assert.ok(lease);
	runs.rows[0]!.cancelRequested = true;
	await assert.rejects(
		appendAgentStep({ runId: "run-1", decisionIndex: 0, subIndex: 0, type: "model", lease }),
		/cancelled/,
	);
});

function staleRunning(extra: FakeRow = {}): FakeRow {
	return runRow({
		status: "running",
		leaseOwner: "dead",
		leaseToken: "tok-old",
		leaseUntil: ago(2 * 60 * MIN),
		updatedAt: ago(2 * 60 * MIN),
		...extra,
	});
}

test("W2: reconciliador recupera run com lease vencido", async () => {
	runs.rows = [staleRunning()];
	assert.deepEqual(await recoverStaleRunningRuns(), ["run-1"]);
	assert.equal(runs.rows[0]!.status, "queued");
	assert.equal(runs.rows[0]!.leaseToken, null);
});

test("recuperação: contador vive no checkpoint e a 3ª recuperação falha o run", async () => {
	runs.rows = [staleRunning({ checkpointJson: { version: 2, messages: [], nextStepIndex: 4 } })];
	for (const expected of [1, 2]) {
		assert.deepEqual(await recoverStaleRunningRuns(), ["run-1"]);
		const row = runs.rows[0]!;
		assert.equal(row.status, "queued");
		assert.equal((row.checkpointJson as { recoveries: number }).recoveries, expected);
		// O resto do checkpoint segue intacto.
		assert.equal((row.checkpointJson as { nextStepIndex: number }).nextStepIndex, 4);
		// O worker pegou o run de novo e sumiu outra vez.
		Object.assign(row, staleRunning({ checkpointJson: row.checkpointJson }));
	}
	assert.deepEqual(await recoverStaleRunningRuns(), []);
	const row = runs.rows[0]!;
	assert.equal(row.status, "failed");
	assert.equal(row.error, "Esta tarefa derrubou o processamento repetidas vezes e foi interrompida.");
	assert.ok(row.finishedAt instanceof Date);
	assert.equal(row.leaseToken, null);
});

test("recuperação: uma única recuperação normal reenfileira", async () => {
	runs.rows = [staleRunning({ checkpointJson: { version: 2, messages: [] } })];
	assert.deepEqual(await recoverStaleRunningRuns(), ["run-1"]);
	assert.equal(runs.rows[0]!.status, "queued");
	assert.equal(runs.rows[0]!.jobEnqueuedAt, null);
});

test("recuperação: checkpoint antigo sem o campo conta como 0; sem checkpoint também reenfileira", async () => {
	runs.rows = [staleRunning({ checkpointJson: { version: 1, messages: [] } })];
	assert.deepEqual(await recoverStaleRunningRuns(), ["run-1"]);
	assert.equal((runs.rows[0]!.checkpointJson as { recoveries: number }).recoveries, 1);
	runs.rows = [staleRunning({ checkpointJson: null })];
	assert.deepEqual(await recoverStaleRunningRuns(), ["run-1"]);
	assert.equal(runs.rows[0]!.status, "queued");
});

test("W2: corrida heartbeat × reconciler — renovação entre SELECT e UPDATE vence", async () => {
	runs.rows = [staleRunning()];
	runs.afterFindMany = () => {
		// O dono ainda vivo renova exatamente depois da seleção do reconciliador.
		runs.rows[0]!.leaseUntil = ahead(40_000);
		runs.rows[0]!.updatedAt = new Date();
	};
	assert.deepEqual(await recoverStaleRunningRuns(), []);
	assert.equal(runs.rows[0]!.status, "running");
	assert.equal(runs.rows[0]!.leaseToken, "tok-old");
});

test("W2: corrida — outro executor assumiu (token novo) entre SELECT e UPDATE", async () => {
	for (const reconcile of [
		() => recoverStaleRunningRuns(),
		() => failStaleRunningRuns(),
	]) {
		runs.rows = [staleRunning()];
		runs.afterFindMany = () => {
			// Novo token com validade futura; sem conferir `leaseToken`+validade o UPDATE passaria.
			runs.rows[0]!.leaseToken = "tok-new";
			runs.rows[0]!.leaseUntil = ahead(40_000);
		};
		assert.deepEqual(await reconcile(), []);
		assert.equal(runs.rows[0]!.status, "running");
		assert.equal(runs.rows[0]!.leaseToken, "tok-new");
	}
});

test("W2: cancelamento órfão não finaliza se o lease foi renovado na corrida", async () => {
	runs.rows = [staleRunning({ cancelRequested: true })];
	runs.afterFindMany = () => {
		runs.rows[0]!.leaseUntil = ahead(40_000);
		runs.rows[0]!.updatedAt = new Date();
	};
	assert.deepEqual(await cancelStaleCancelledRuns(30_000), []);
	assert.equal(runs.rows[0]!.status, "running");
});

test("W4: gravar a sessão do sandbox preserva o checkpoint completo", async () => {
	const lease = await tryAcquireRunLease("run-1", "o1");
	assert.ok(lease);
	const checkpoint = {
		version: 2,
		messages: [{ role: "user", content: "oi" }],
		llmMessages: [{ role: "assistant", content: "x" }],
		nextStepIndex: 7,
		model: "m",
		consumedInputIds: ["i1"],
		skillPins: [{ skillId: "s", versionId: "v" }],
		budget: { maxTokens: 10 },
		pendingLogin: { host: "example.com" },
	};
	runs.rows[0]!.checkpointJson = checkpoint;
	await setRunSandboxSession("run-1", "sess-9", lease);
	assert.deepEqual(runs.rows[0]!.checkpointJson, { ...checkpoint, sandboxSessionId: "sess-9" });
	assert.equal(runs.rows[0]!.sandboxSessionId, "sess-9");
});

test("W4: sem checkpoint grava só a coluna; lease vencido não grava", async () => {
	const lease = await tryAcquireRunLease("run-1", "o1");
	assert.ok(lease);
	await setRunSandboxSession("run-1", "sess-1", lease);
	assert.equal(runs.rows[0]!.checkpointJson, undefined);
	assert.equal(runs.rows[0]!.sandboxSessionId, "sess-1");
	runs.rows[0]!.leaseUntil = ago(1);
	await assert.rejects(setRunSandboxSession("run-1", "sess-2", lease), /lease_lost/);
	assert.equal(runs.rows[0]!.sandboxSessionId, "sess-1");
});

test("L10: com lease vigente o fence é um UPDATE só (sem ler o run depois)", async () => {
	const lease = await tryAcquireRunLease("run-1", "o1");
	assert.ok(lease);
	emulateStepUpsert();
	let reads = 0;
	const originalFindFirst = runs.findFirst.bind(runs);
	const originalFindUnique = runs.findUnique.bind(runs);
	runs.findFirst = async (args) => (reads++, originalFindFirst(args));
	runs.findUnique = async (args) => (reads++, originalFindUnique(args));
	await appendAgentStep({ runId: "run-1", decisionIndex: 0, subIndex: 0, type: "model", lease });
	assert.equal(reads, 0);
	assert.equal(steps.rows.length, 1);
});
