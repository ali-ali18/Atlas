/** Falhas recentes do Diagnóstico contra Postgres real: só do dono, motivo curto e sem segredos. */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { prisma } from "./client.js";
import { listRecentFailures, pingDatabase } from "./diagnostics.js";
import { createTestBot, createTestUser, dbSkip } from "./testing/test-db.js";

describe("diagnostics (Postgres real)", { skip: dbSkip }, () => {
	let userId: string;
	let otherId: string;

	before(async () => {
		userId = (await createTestUser("diag")).id;
		otherId = (await createTestUser("diag-other")).id;
		const bot = await createTestBot(userId);
		const otherBot = await createTestBot(otherId);
		await prisma.agentRun.create({
			data: { userId, botId: bot.id, objective: "rodar teste", status: "failed", model: "m", error: "boom Authorization: Bearer abcdefghijklmnop\n" + "x".repeat(400), finishedAt: new Date("2026-10-15T10:00:00Z") },
		});
		await prisma.agentRun.create({ data: { userId, botId: bot.id, objective: "ok", status: "done", model: "m" } });
		await prisma.agentRun.create({ data: { userId: otherId, botId: otherBot.id, objective: "alheio", status: "failed", model: "m", error: "segredo do outro" } });
		await prisma.orchestratorReflection.create({ data: { userId, trigger: "scheduled", status: "failed", detail: "sem OPENROUTER_API_KEY", finishedAt: new Date("2026-10-15T11:00:00Z") } });
		const routine = await prisma.routine.create({ data: { userId, botId: bot.id, name: "Resumo diário", prompt: "p" } });
		await prisma.routineRun.create({ data: { routineId: routine.id, status: "failed", error: "?secret=abc123 falhou", finishedAt: new Date("2026-10-15T12:00:00Z") } });
	});
	after(async () => {
		await prisma.$disconnect();
	});

	test("lista runs, reflexões e rotinas que falharam, da mais nova para a mais antiga", async () => {
		const failures = await listRecentFailures(userId, 10);
		assert.deepEqual(failures.map((f) => f.kind), ["routine", "reflection", "run"]);
		assert.equal(failures[0]!.label, "Resumo diário");
		assert.equal(failures[1]!.reason, "sem OPENROUTER_API_KEY");
	});

	test("motivo curto, uma linha e sem segredos; nada do outro usuário", async () => {
		const failures = await listRecentFailures(userId, 10);
		const run = failures.find((f) => f.kind === "run")!;
		assert.ok(run.reason.length <= 160);
		assert.ok(!run.reason.includes("\n"));
		const text = JSON.stringify(failures);
		assert.ok(!text.includes("abcdefghijklmnop"));
		assert.ok(!text.includes("abc123"));
		assert.ok(!text.includes("segredo do outro"));
		assert.deepEqual((await listRecentFailures(otherId)).map((f) => f.label), ["alheio"]);
	});

	test("pingDatabase responde", async () => {
		const ping = await pingDatabase();
		assert.equal(ping.ok, true);
	});
});
