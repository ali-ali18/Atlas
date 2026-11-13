/**
 * Pausa de um run que estacionou esperando o dono (Motor v4) contra Postgres real. Pulado sem ATLAS_TEST_DB_URL.
 * Caso real (piloto de 13/11): o v4 lançava a pausa sem marcar o run como `paused`; `releasePausedRunLease` só solta o
 * lease de run `paused`, então o run ficava `running` e a API recusava toda aprovação com 409 `run_not_paused`.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { prisma } from "./client.js";
import { releasePausedRunLease, requestPauseAgentRun, requestResumeAgentRun } from "./runs.js";
import { createTestBot, createTestUser, dbSkip } from "./testing/test-db.js";

describe("pausa esperando o dono (Postgres real)", { skip: dbSkip }, () => {
	let userId: string;
	let botId: string;
	const lease = { owner: "worker-1", token: "token-1", generation: 1 };

	before(async () => {
		userId = (await createTestUser("pause-owner")).id;
		botId = (await createTestBot(userId)).id;
	});
	after(async () => {
		await prisma.$disconnect();
	});

	const runningRun = () =>
		prisma.agentRun.create({ data: { userId, botId, objective: "o", model: "m", status: "running", leaseOwner: lease.owner, leaseToken: lease.token, leaseUntil: new Date(Date.now() + 60_000) } });

	test("sem marcar a pausa antes, soltar o lease falha e o run segue `running` (o defeito)", async () => {
		const run = await runningRun();
		await assert.rejects(releasePausedRunLease(run.id, lease), /lease_lost/);
		assert.equal((await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })).status, "running");
	});

	test("marcar a pausa e soltar o lease deixa o run `paused`, sem lease, e a retomada o recoloca na fila", async () => {
		const run = await runningRun();
		await requestPauseAgentRun(run.id);
		await releasePausedRunLease(run.id, lease);
		const paused = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
		assert.equal(paused.status, "paused");
		assert.equal(paused.leaseOwner, null);
		const resumed = await requestResumeAgentRun(run.id);
		assert.ok(resumed, "a retomada aceita o run pausado sem lease");
		assert.notEqual(resumed?.status, "paused");
	});

	test("estacionado esperando o dono grava awaiting_owner (não paused_login) e a retomada limpa o motivo", async () => {
		const run = await runningRun();
		await requestPauseAgentRun(run.id);
		await releasePausedRunLease(run.id, lease, "awaiting_owner");
		assert.equal((await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })).stopReason, "awaiting_owner");
		await requestResumeAgentRun(run.id);
		assert.equal((await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })).stopReason, null);
	});
});
