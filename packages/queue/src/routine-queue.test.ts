import { describe, expect, it, vi } from "vitest";
import { enqueueRoutineEventDeferred, type RoutineQueue } from "./routine-queue.js";

describe("enqueueRoutineEventDeferred", () => {
	it("re-enfileira o mesmo evento com delay e jobId novo por adiamento", async () => {
		const add = vi.fn(async () => undefined);
		const queue = { add } as unknown as RoutineQueue;
		const payload = {
			routineId: "r1",
			routineRunId: "run1",
			triggeredBy: "event" as const,
			deferredSince: "2026-10-13T00:00:00.000Z",
			deferrals: 2,
		};
		await enqueueRoutineEventDeferred(queue, payload, 90_000);
		expect(add).toHaveBeenCalledTimes(1);
		const [, data, opts] = add.mock.calls[0] as unknown as [string, unknown, { jobId: string; delay: number }];
		expect(data).toEqual(payload);
		expect(opts).toEqual({ jobId: "routine-event-run1-defer-2", delay: 90_000 });
	});
});

it("rotina tenta de novo uma vez, com espera curta fixa", async () => {
	const { ROUTINE_JOB_RETRY } = await import("./routine-queue.js");
	expect(ROUTINE_JOB_RETRY.attempts).toBe(2);
	expect(ROUTINE_JOB_RETRY.backoff).toEqual({ type: "fixed", delay: 20_000 });
});
