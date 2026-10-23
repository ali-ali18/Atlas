import assert from "node:assert/strict";
import { test } from "node:test";
import { ATLAS_JOB_NAMES } from "@workspace/shared";
import { DATA_RETENTION_REPEAT, DATA_RETENTION_SCHEDULER_ID, processDataRetention, scheduleDataRetention } from "./data-retention.js";

test("um agendamento diário de madrugada, id fixo (vários workers não duplicam)", async () => {
	const calls: unknown[][] = [];
	const upsertJobScheduler = async (...args: unknown[]) => {
		calls.push(args);
		return undefined as never;
	};
	await scheduleDataRetention({ upsertJobScheduler } as unknown as Parameters<typeof scheduleDataRetention>[0]);
	assert.equal(calls.length, 1);
	const [id, repeat, template] = calls[0] as [string, { pattern: string; tz: string }, { name: string }];
	assert.equal(id, DATA_RETENTION_SCHEDULER_ID);
	assert.deepEqual(repeat, { pattern: "17 4 * * *", tz: "America/Sao_Paulo" });
	assert.deepEqual(DATA_RETENTION_REPEAT, repeat);
	assert.equal(template.name, ATLAS_JOB_NAMES.dataRetention);
});

test("o job roda a retenção com o horário de agora e devolve as contagens", async () => {
	const now = new Date("2026-10-23T07:17:00.000Z");
	let seen: Date | undefined;
	const log = console.log;
	console.log = () => undefined;
	try {
		const result = await processDataRetention(async (at) => ((seen = at), { runEvents: 12, routineRuns: 3 }), now);
		assert.deepEqual(result, { runEvents: 12, routineRuns: 3 });
		assert.equal(seen, now);
	} finally {
		console.log = log;
	}
});
