/**
 * Retenção diária: corte puro com `now` injetado e as limpezas em lote contra tabelas em memória.
 * Runner: node:test (sem banco).
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

process.env.ATLAS_HOOK_PEPPER ||= "test-pepper";
const { prisma } = await import("./client.js");
const { planRetention, pruneOldRunEvents, pruneRoutineRuns, runDataRetention, RETAINED_RUN_EVENT_TYPES } = await import("./retention.js");

type Row = Record<string, unknown>;
const NOW = new Date("2026-10-23T07:17:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const noPause = async () => undefined;

const restores: Array<() => void> = [];
function stub(target: object, name: string, value: unknown) {
	const original = Reflect.get(target, name);
	Object.assign(target, { [name]: value });
	restores.push(() => Object.assign(target, { [name]: original }));
}
afterEach(() => {
	for (const restore of restores.splice(0).reverse()) restore();
});

/** Paginação por cursor de id (como o Prisma): `cursor` + `skip: 1` começa depois do id. */
function page<T extends Row>(rows: T[], args: { take?: number; skip?: number; cursor?: { id: string } }): T[] {
	let list = rows;
	if (args.cursor) list = list.filter((row) => (row.id as string) > args.cursor!.id);
	else if (args.skip) list = list.slice(args.skip);
	return list.slice(0, args.take ?? list.length);
}

function installRuns(runs: Row[], events: Row[]) {
	stub(prisma.agentRun, "findMany", async (args: { where: { status: { in: string[] }; finishedAt: { lt: Date } }; take?: number; cursor?: { id: string } }) =>
		page(
			[...runs]
				.filter((run) => args.where.status.in.includes(run.status as string) && run.finishedAt instanceof Date && run.finishedAt < args.where.finishedAt.lt)
				.sort((a, b) => ((a.id as string) < (b.id as string) ? -1 : 1)),
			args,
		).map((run) => ({ id: run.id })),
	);
	stub(prisma.runEvent, "findMany", async (args: { where: { runId: { in: string[] }; type: { notIn: string[] } }; take: number }) =>
		events.filter((event) => args.where.runId.in.includes(event.runId as string) && !args.where.type.notIn.includes(event.type as string)).slice(0, args.take).map((event) => ({ id: event.id })),
	);
	stub(prisma.runEvent, "deleteMany", async (args: { where: { id: { in: string[] } } }) => {
		const before = events.length;
		for (let i = events.length - 1; i >= 0; i -= 1) if (args.where.id.in.includes(events[i]!.id as string)) events.splice(i, 1);
		return { count: before - events.length };
	});
}

test("planRetention: 30 dias antes de now; 50 execuções por rotina", () => {
	assert.deepEqual(planRetention(NOW), { runEventsBefore: new Date(NOW.getTime() - 30 * DAY), routineRunsKeep: 50 });
	assert.deepEqual(planRetention(NOW, { runEventsDays: 7, routineRunsKeep: 3 }).runEventsBefore, new Date(NOW.getTime() - 7 * DAY));
});

test("eventos de run encerrado há 30+ dias saem (menos os tipos que a UI lê); runs recentes e em andamento ficam intactos", async () => {
	const runs: Row[] = [
		{ id: "old", status: "completed", finishedAt: new Date(NOW.getTime() - 40 * DAY) },
		{ id: "old-failed", status: "failed", finishedAt: new Date(NOW.getTime() - 31 * DAY) },
		{ id: "recent", status: "completed", finishedAt: new Date(NOW.getTime() - 5 * DAY) },
		// Parado há meses num card: ainda pode continuar, não é "encerrado".
		{ id: "paused", status: "paused", finishedAt: null },
		{ id: "running", status: "running", finishedAt: null },
	];
	const events: Row[] = [];
	let seq = 0;
	for (const run of runs) {
		for (const type of ["assistant_delta", "tool_result", "status", "shell_output", "done", "inspect_context", "error", "lesson_review"]) {
			events.push({ id: `e${String(seq++).padStart(3, "0")}`, runId: run.id, type });
		}
	}
	installRuns(runs, events);
	const deleted = await pruneOldRunEvents(planRetention(NOW).runEventsBefore, { batchSize: 3, pause: noPause });
	assert.equal(deleted, 8);
	const left = (runId: string) => events.filter((event) => event.runId === runId).map((event) => event.type);
	assert.deepEqual(left("old"), ["done", "inspect_context", "error", "lesson_review"]);
	assert.deepEqual(left("old-failed"), ["done", "inspect_context", "error", "lesson_review"]);
	for (const runId of ["recent", "paused", "running"]) assert.equal(left(runId).length, 8, runId);
	for (const type of ["done", "inspect_context", "inspect_hooks", "inspect_lessons", "error", "lesson_review", "shell_started", "file_edit"]) {
		assert.ok((RETAINED_RUN_EVENT_TYPES as readonly string[]).includes(type), type);
	}
	// Rodar de novo não acha mais nada.
	assert.equal(await pruneOldRunEvents(planRetention(NOW).runEventsBefore, { batchSize: 3, pause: noPause }), 0);
});

test("rotinas: a 51ª execução em diante sai, por rotina; execução em andamento nunca", async () => {
	const routines: Row[] = [{ id: "r1" }, { id: "r2" }];
	const runs: Row[] = [];
	for (let i = 0; i < 60; i += 1) runs.push({ id: `r1-${String(i).padStart(2, "0")}`, routineId: "r1", status: i === 0 ? "queued" : "succeeded", createdAt: new Date(NOW.getTime() - (60 - i) * 60_000) });
	// i=0 é a MAIS ANTIGA (fora das 50) mas está na fila: fica.
	for (let i = 0; i < 10; i += 1) runs.push({ id: `r2-${i}`, routineId: "r2", status: "failed", createdAt: new Date(NOW.getTime() - i * 60_000) });
	stub(prisma.routine, "findMany", async (args: { take?: number; cursor?: { id: string } }) => page(routines, args));
	stub(prisma.routineRun, "findMany", async (args: { where: { routineId: string }; skip: number; take: number }) =>
		runs
			.filter((run) => run.routineId === args.where.routineId)
			.sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime())
			.slice(args.skip, args.skip + args.take)
			.map((run) => ({ id: run.id, status: run.status })),
	);
	stub(prisma.routineRun, "deleteMany", async (args: { where: { id: { in: string[] }; routineId: string } }) => {
		const before = runs.length;
		for (let i = runs.length - 1; i >= 0; i -= 1) if (args.where.id.in.includes(runs[i]!.id as string) && runs[i]!.routineId === args.where.routineId) runs.splice(i, 1);
		return { count: before - runs.length };
	});
	const deleted = await pruneRoutineRuns(50, { batchSize: 4, pause: noPause });
	assert.equal(deleted, 9);
	const r1 = runs.filter((run) => run.routineId === "r1");
	assert.equal(r1.length, 51);
	assert.ok(r1.some((run) => run.id === "r1-00"), "a execução na fila ficou");
	assert.deepEqual(
		r1.filter((run) => run.id !== "r1-00").map((run) => run.id).sort(),
		Array.from({ length: 50 }, (_, i) => `r1-${String(i + 10).padStart(2, "0")}`),
	);
	assert.equal(runs.filter((run) => run.routineId === "r2").length, 10);
});

test("runDataRetention: uma parte que falha não impede a outra, e o erro sobe", async () => {
	installRuns([], []);
	stub(prisma.agentRun, "findMany", async () => {
		throw new Error("db fora");
	});
	let routinesQueried = false;
	stub(prisma.routine, "findMany", async () => ((routinesQueried = true), []));
	await assert.rejects(() => runDataRetention(NOW, { pause: noPause }), /db fora/);
	assert.equal(routinesQueried, true);
});
