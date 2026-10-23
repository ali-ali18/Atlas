/**
 * Listagens sem as colunas grandes: bots sem o JSON da limpeza de memória/autonomia; rotinas com a última
 * execução por LATERAL (não todas as execuções) e execuções recentes por `routineId IN (...)`. Prisma
 * interceptado; sem banco.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";
const { prisma } = await import("./client.js");
const { listBots } = await import("./bots.js");
const { listRecentRoutineRunsForBot, listRoutines } = await import("./routines.js");

const restores: Array<() => void> = [];
function stub(target: object, name: string, value: unknown) {
	const original = Reflect.get(target, name);
	Object.assign(target, { [name]: value });
	restores.push(() => Object.assign(target, { [name]: original }));
}
afterEach(() => {
	for (const restore of restores.splice(0).reverse()) restore();
});

const NOW = new Date("2026-10-11T12:00:00.000Z");

test("listBots seleciona só o que o card do bot mostra (sem memoryCleanupJson/autonomyJson)", async () => {
	let args: { where?: unknown; select?: Record<string, boolean> } | undefined;
	stub(prisma.bot, "findMany", async (input: typeof args) => {
		args = input;
		throw new Error("parou aqui");
	});
	await assert.rejects(() => listBots("user-a"), /parou aqui/);
	assert.deepEqual(args?.where, { ownerId: { in: ["user-a"] } });
	assert.ok(args?.select);
	for (const big of ["memoryCleanupJson", "autonomyJson", "memoryCleanupError"]) assert.equal(big in args!.select!, false, big);
	assert.equal(args!.select!.policyJson, true);
});

test("listRoutines: última execução de cada rotina numa consulta LATERAL LIMIT 1, sem include de runs", async () => {
	const routine = { id: "r1", botId: "b1", userId: "user-a", conversationId: null, groupId: null, group: null, name: "R", prompt: "p", model: null, allowChatgptPlan: false, enabled: true, triggerType: "cron", schedule: "0 9 * * *", timezone: "UTC", triggerJson: null, alertJson: null, pageId: null, notify: true, createdBy: "user", lastRunAt: null, createdAt: NOW, updatedAt: NOW };
	let findArgs: Record<string, unknown> | undefined;
	stub(prisma.routine, "findMany", async (input: Record<string, unknown>) => ((findArgs = input), [routine]));
	let sql = "";
	let ids: unknown;
	stub(prisma, "$queryRaw", async (strings: TemplateStringsArray, ...values: unknown[]) => {
		sql = strings.join("?");
		ids = values[0];
		return [{ id: "run-9", routineId: "r1", agentRunId: null, triggeredBy: "schedule", scheduledFor: null, status: "succeeded", startedAt: NOW, finishedAt: NOW, error: null, summary: "ok", eventJson: null, createdAt: NOW }];
	});
	const list = await listRoutines("user-a", "b1");
	assert.equal(list[0]!.lastRun?.id, "run-9");
	assert.equal("runs" in ((findArgs!.include as Record<string, unknown>) ?? {}), false);
	assert.deepEqual(findArgs!.where, { botId: "b1", userId: { in: ["user-a"] } });
	assert.match(sql, /CROSS JOIN LATERAL[\s\S]*ORDER BY x\."createdAt" DESC\s+LIMIT 1/);
	assert.deepEqual(ids, ["r1"]);
});

test("listRecentRoutineRunsForBot: execuções por routineId IN (rotinas do dono); outro dono não vê nada", async () => {
	stub(prisma.routine, "findMany", async ({ where }: { where: { userId: { in: string[] } } }) =>
		where.userId.in.includes("user-a") ? [{ id: "r1", name: "Relatório" }] : [],
	);
	let runArgs: Record<string, unknown> | undefined;
	stub(prisma.routineRun, "findMany", async (input: Record<string, unknown>) => {
		runArgs = input;
		return [{ id: "run-1", routineId: "r1", agentRunId: null, triggeredBy: "schedule", scheduledFor: null, status: "succeeded", startedAt: NOW, finishedAt: NOW, error: null, summary: null, eventJson: null, createdAt: NOW }];
	});
	const runs = await listRecentRoutineRunsForBot("user-a", "b1", 5);
	assert.deepEqual(runs.map((run) => [run.id, run.routineName]), [["run-1", "Relatório"]]);
	assert.deepEqual(runArgs!.where, { routineId: { in: ["r1"] } });
	assert.equal(runArgs!.take, 5);
	runArgs = undefined;
	assert.deepEqual(await listRecentRoutineRunsForBot("user-b", "b1"), []);
	assert.equal(runArgs, undefined, "sem rotina do dono, nem consulta as execuções");
});
