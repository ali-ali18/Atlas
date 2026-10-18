/**
 * Reflexão do orquestrador contra Postgres real: claim agendado (lock advisory), fila manual
 * (`FOR UPDATE SKIP LOCKED` via queryRaw), stale e dono. Pulado sem ATLAS_TEST_DB_URL.
 * Runner: `pnpm --filter @workspace/db test:db`.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { prisma } from "./client.js";
import {
	claimQueuedReflection,
	claimScheduledReflection,
	deleteOwnedMemory,
	enqueueManualReflection,
	failStaleReflections,
	finishReflection,
	getOwnedMemory,
	getReflectionClock,
	hasActivitySince,
	listReflections,
	loadReflectionInput,
	updateOwnedMemory,
} from "./reflection.js";
import { createTestBot, createTestUser, dbSkip } from "./testing/test-db.js";

const MIN = 60_000;

describe("reflection (Postgres real)", { skip: dbSkip }, () => {
	let userId: string;
	let botId: string;
	let otherUserId: string;

	before(async () => {
		userId = (await createTestUser("refl")).id;
		otherUserId = (await createTestUser("refl-other")).id;
		botId = (await createTestBot(userId, { isPrimary: true })).id;
	});
	beforeEach(async () => {
		await prisma.orchestratorReflection.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
	});
	after(async () => {
		await prisma.$disconnect();
	});

	test("claimScheduledReflection: chamadas concorrentes, só uma reserva o horário", async () => {
		const now = new Date();
		const slotStart = new Date(now.getTime() - 5 * MIN);
		const results = await Promise.all([
			claimScheduledReflection({ userId, botId, now, slotStart }),
			claimScheduledReflection({ userId, botId, now, slotStart }),
			claimScheduledReflection({ userId, botId, now, slotStart }),
		]);
		assert.equal(results.filter(Boolean).length, 1);
		const row = results.find(Boolean)!;
		assert.equal(row.status, "running");
		assert.equal(row.trigger, "scheduled");
	});

	test("claimScheduledReflection: tentativa depois do horário => null; novo horário reserva e herda sinceAt", async () => {
		const now = new Date();
		const first = await claimScheduledReflection({ userId, botId, now, slotStart: new Date(now.getTime() - MIN) });
		assert.ok(first);
		await finishReflection(first.id, { status: "done", summary: "ok", now });
		assert.equal(
			await claimScheduledReflection({ userId, botId, now: new Date(now.getTime() + MIN), slotStart: new Date(now.getTime() - MIN) }),
			null,
		);
		const next = await claimScheduledReflection({
			userId,
			botId,
			now: new Date(now.getTime() + 2 * MIN),
			slotStart: new Date(now.getTime() + MIN),
		});
		assert.ok(next);
		assert.equal(next.sinceAt?.getTime(), now.getTime());
	});

	test("fila manual: um pedido por vez; claim sem duplicar; dono preservado", async () => {
		const a = await enqueueManualReflection(userId);
		assert.equal(a.ok, true);
		assert.deepEqual(await enqueueManualReflection(userId), { ok: false, reason: "busy" });
		assert.deepEqual(await enqueueManualReflection(otherUserId), { ok: false, reason: "no-primary" });

		const now = new Date();
		const [c1, c2] = await Promise.all([claimQueuedReflection(now), claimQueuedReflection(now)]);
		const claimed = [c1, c2].filter(Boolean);
		assert.equal(claimed.length, 1, "SKIP LOCKED: só um worker pega a linha");
		assert.equal(claimed[0]!.status, "running");
		assert.equal(claimed[0]!.userId, userId);
		assert.equal(claimed[0]!.startedAt?.getTime(), now.getTime());
		assert.equal(await claimQueuedReflection(now), null);
		assert.deepEqual(await enqueueManualReflection(userId, now), { ok: false, reason: "busy" });
	});

	test("claimQueuedReflection pega o mais antigo primeiro", async () => {
		const older = await prisma.orchestratorReflection.create({
			data: { userId, botId, trigger: "manual", status: "queued", createdAt: new Date(Date.now() - 10 * MIN) },
		});
		const newer = await prisma.orchestratorReflection.create({
			data: { userId: otherUserId, trigger: "manual", status: "queued" },
		});
		assert.equal((await claimQueuedReflection(new Date()))?.id, older.id);
		assert.equal((await claimQueuedReflection(new Date()))?.id, newer.id);
	});

	test("failStaleReflections: só running antigo vira failed", async () => {
		const now = new Date();
		const stale = await prisma.orchestratorReflection.create({
			data: { userId, botId, trigger: "scheduled", status: "running", startedAt: new Date(now.getTime() - 30 * MIN) },
		});
		const fresh = await prisma.orchestratorReflection.create({
			data: { userId: otherUserId, trigger: "scheduled", status: "running", startedAt: new Date(now.getTime() - MIN) },
		});
		assert.ok((await failStaleReflections(now)) >= 1);
		assert.equal((await prisma.orchestratorReflection.findUnique({ where: { id: stale.id } }))?.status, "failed");
		assert.equal((await prisma.orchestratorReflection.findUnique({ where: { id: fresh.id } }))?.status, "running");
	});

	test("finishReflection trunca textos; relógio e listagem refletem o histórico", async () => {
		const now = new Date();
		const row = await claimScheduledReflection({ userId, botId, now, slotStart: new Date(now.getTime() - MIN) });
		await finishReflection(row!.id, { status: "done", summary: "x".repeat(5000), detail: "y".repeat(500), now });
		const clock = await getReflectionClock(userId);
		assert.equal(clock.lastDoneAt?.getTime(), now.getTime());
		const [view] = await listReflections(userId, 5);
		assert.equal(view!.summary!.length, 4000);
		assert.equal(view!.detail!.length, 300);
		assert.equal(view!.status, "done");
		assert.deepEqual(await listReflections(otherUserId), []);
	});

	test("memórias por id só do dono e loadReflectionInput lê só os bots dele", async () => {
		const mine = await prisma.memoryEntry.create({ data: { userId, botId, target: "memory", content: "fato meu" } });
		const profile = await prisma.memoryEntry.create({ data: { userId, target: "user", content: "perfil meu" } });
		const theirs = await prisma.memoryEntry.create({ data: { userId: otherUserId, target: "user", content: "perfil alheio" } });
		assert.ok(await getOwnedMemory(userId, mine.id));
		assert.equal(await getOwnedMemory(userId, theirs.id), null);
		assert.equal(await updateOwnedMemory(userId, theirs.id, { content: "invadido" }), false);
		assert.equal(await deleteOwnedMemory(userId, theirs.id), false);
		assert.equal((await prisma.memoryEntry.findUnique({ where: { id: theirs.id } }))?.content, "perfil alheio");
		assert.equal(await updateOwnedMemory(userId, mine.id, { content: "fato editado", importance: 2 }), true);

		const input = await loadReflectionInput({ userId, since: null, now: new Date(), timeZone: "America/Sao_Paulo" });
		assert.equal(input.primaryBotId, botId);
		assert.deepEqual(input.userMemories.map((m) => m.id), [profile.id]);
		assert.deepEqual(input.bots.find((b) => b.id === botId)?.memories.map((m) => m.content), ["fato editado"]);
		assert.equal(await deleteOwnedMemory(userId, mine.id), true);
	});

	test("hasActivitySince: run com erro conta; sem atividade não", async () => {
		const now = new Date();
		assert.equal(await hasActivitySince(userId, new Date(now.getTime() - MIN), now), false);
		await prisma.agentRun.create({
			data: { userId, botId, objective: "falha", status: "failed", origin: "chat", model: "test", error: "boom" },
		});
		assert.equal(await hasActivitySince(userId, new Date(now.getTime() - 5 * MIN), now), true);
	});
});
