import assert from "node:assert/strict";
import { test } from "node:test";
import {
	rehydrateRoutineSchedulers,
	routineRepeatOptions,
	syncRoutineScheduler,
	type RoutineQueue,
} from "@workspace/queue";

type Upsert = { id: string; repeat: unknown; template: unknown };

function fakeQueue(existing: string[] = []) {
	const upserts: Upsert[] = [];
	const removed: string[] = [];
	const queue = {
		upsertJobScheduler: async (id: string, repeat: unknown, template: unknown) => {
			upserts.push({ id, repeat, template });
		},
		removeJobScheduler: async (id: string) => {
			removed.push(id);
			return true;
		},
		getJobSchedulers: async () => existing.map((key) => ({ key })),
		getJob: async () => null,
	} as unknown as RoutineQueue;
	return { queue, upserts, removed };
}

const base = { id: "r1", enabled: true, schedule: null, timezone: "America/Sao_Paulo" } as const;

test("syncRoutineScheduler: interval agenda com `every` em ms (50 min = 3.000.000 ms)", async () => {
	const { queue, upserts } = fakeQueue();
	await syncRoutineScheduler(queue, {
		...base,
		triggerType: "interval",
		interval: { everyMinutes: 50 },
	});
	assert.equal(upserts.length, 1);
	assert.equal(upserts[0]?.id, "routine:r1");
	assert.deepEqual(upserts[0]?.repeat, { every: 3_000_000 });
	assert.deepEqual(upserts[0]?.template, {
		name: "execute-routine",
		data: { routineId: "r1", triggeredBy: "schedule" },
		opts: { attempts: 2, backoff: { type: "fixed", delay: 20_000 } },
	});
});

test("syncRoutineScheduler: interval pausado remove o scheduler", async () => {
	const { queue, upserts, removed } = fakeQueue();
	await syncRoutineScheduler(queue, {
		...base,
		enabled: false,
		triggerType: "interval",
		interval: { everyMinutes: 50 },
	});
	assert.equal(upserts.length, 0);
	assert.deepEqual(removed, ["routine:r1"]);
});

test("syncRoutineScheduler: cron continua usando pattern + tz", async () => {
	const { queue, upserts } = fakeQueue();
	await syncRoutineScheduler(queue, { ...base, schedule: "0 9 * * *", triggerType: "cron" });
	assert.deepEqual(upserts[0]?.repeat, { pattern: "0 9 * * *", tz: "America/Sao_Paulo" });
});

test("routineRepeatOptions: interval sem everyMinutes e event não repetem", () => {
	assert.equal(routineRepeatOptions({ ...base, triggerType: "interval" }), null);
	assert.equal(routineRepeatOptions({ ...base, triggerType: "event" }), null);
});

test("rehydrateRoutineSchedulers (boot): mantém interval e remove scheduler órfão", async () => {
	const { queue, upserts, removed } = fakeQueue(["routine:r1", "routine:orfa"]);
	await rehydrateRoutineSchedulers(queue, [
		{ ...base, triggerType: "interval", interval: { everyMinutes: 60 } },
	]);
	assert.deepEqual(removed.filter((id) => id === "routine:orfa"), ["routine:orfa"]);
	assert.equal(removed.includes("routine:r1"), false);
	assert.deepEqual(upserts[0]?.repeat, { every: 3_600_000 });
});
