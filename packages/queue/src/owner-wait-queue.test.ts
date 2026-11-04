import { describe, expect, it, vi } from "vitest";
import { cancelOwnerWaitTimeout, cancelReturnJob, scheduleOwnerWaitTimeout, scheduleReturnJob, type OwnerWaitQueue } from "./owner-wait-queue.js";

function fakeQueue() {
	const jobs = new Map<string, { remove: () => Promise<void> }>();
	const add = vi.fn(async (_name: string, _data: unknown, opts: { jobId: string; delay: number }) => {
		jobs.set(opts.jobId, { remove: async () => void jobs.delete(opts.jobId) });
		return undefined;
	});
	const getJob = vi.fn(async (id: string) => jobs.get(id) ?? null);
	return { queue: { add, getJob } as unknown as OwnerWaitQueue, add, jobs };
}

const timeout = { kind: "card_timeout" as const, userId: "u1", conversationId: "c1", runId: "r1", card: "tool-call" as const, cardId: "confirm-toolab12cd34-r1", what: "x", minutes: 30 };

describe("fila do esperar o dono", () => {
	it("prazo vira job atrasado com jobId do cartão", async () => {
		const { queue, add } = fakeQueue();
		await scheduleOwnerWaitTimeout(queue, timeout);
		const [name, data, opts] = add.mock.calls[0]!;
		expect(name).toBe("owner-wait.timeout");
		expect(data).toEqual(timeout);
		expect(opts).toEqual({ jobId: "owner-wait-confirm-toolab12cd34-r1", delay: 30 * 60_000 });
	});

	it("resposta antes do prazo cancela o job; sem job não falha", async () => {
		const { queue, jobs } = fakeQueue();
		await scheduleOwnerWaitTimeout(queue, timeout);
		expect(await cancelOwnerWaitTimeout(queue, timeout.cardId)).toBe(true);
		expect(jobs.size).toBe(0);
		expect(await cancelOwnerWaitTimeout(queue, timeout.cardId)).toBe(false);
	});

	it("retorno agendado e cancelado pelo id", async () => {
		const { queue, add, jobs } = fakeQueue();
		await scheduleReturnJob(queue, { kind: "scheduled_return", userId: "u1", returnId: "ret1" }, 60_000);
		expect(add.mock.calls[0]![2]).toEqual({ jobId: "return-ret1", delay: 60_000 });
		expect(await cancelReturnJob(queue, "ret1")).toBe(true);
		expect(jobs.size).toBe(0);
	});
});
