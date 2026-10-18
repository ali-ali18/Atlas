import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Opt-in: creates isolated fixtures and deletes only those records afterward.
describe.skipIf(!process.env.ATLAS_TEST_DATABASE_URL)("run persistence in Postgres", () => {
	let db: typeof import("../../db/src/client.js");
	let runs: typeof import("../../db/src/runs.js");
	const runIds: string[] = [];
	const conversationIds: string[] = [];
	const lease = { owner: "regression-test", token: randomUUID() };

	beforeAll(async () => {
		process.env.DATABASE_URL = process.env.ATLAS_TEST_DATABASE_URL;
		db = await import("../../db/src/client.js");
		runs = await import("../../db/src/runs.js");
	});

	afterAll(async () => {
		if (!db) return;
		await db.prisma.agentRun.deleteMany({ where: { id: { in: runIds } } });
		await db.prisma.conversation.deleteMany({ where: { id: { in: conversationIds } } });
		await db.prisma.$disconnect();
	});

	async function fixture(status = "running", conversationId?: string) {
		const row = await db.prisma.agentRun.create({ data: {
			objective: "isolated regression fixture", model: "test", status, conversationId,
			leaseOwner: lease.owner, leaseToken: lease.token,
			leaseUntil: new Date(Date.now() + 60_000),
		} });
		runIds.push(row.id);
		return row.id;
	}

	it("rejects a replaced or expired lease without emitting retry events", async () => {
		const id = await fixture();
		expect(await runs.markAgentRunRetrying(id, "old worker", { ...lease, token: "old" })).toBe(false);
		await db.prisma.agentRun.update({ where: { id }, data: { leaseUntil: new Date(0) } });
		expect(await runs.markAgentRunRetrying(id, "expired worker", lease)).toBe(false);
		expect(await db.prisma.runEvent.count({ where: { runId: id } })).toBe(0);
		expect((await runs.getAgentRun(id))?.status).toBe("running");
	});

	it.each(["paused", "cancelled", "completed"])("preserves %s", async (status) => {
		const id = await fixture(status);
		expect(await runs.markAgentRunRetrying(id, "late error", lease)).toBe(false);
		expect((await runs.getAgentRun(id))?.status).toBe(status);
	});

	it("preserves a cancellation request before its status transition", async () => {
		const id = await fixture();
		await db.prisma.agentRun.update({ where: { id }, data: { cancelRequested: true } });
		expect(await runs.markAgentRunRetrying(id, "late error", lease)).toBe(false);
	});

	it("commits retry and exactly one event under concurrent attempts", async () => {
		const id = await fixture();
		const results = await Promise.all([
			runs.markAgentRunRetrying(id, "503", lease),
			runs.markAgentRunRetrying(id, "503", lease),
		]);
		expect(results.filter(Boolean)).toHaveLength(1);
		expect((await runs.getAgentRun(id))?.status).toBe("retrying");
		expect(await db.prisma.runEvent.count({ where: { runId: id, type: "status" } })).toBe(1);
	});

	it("rolls back input if the transcript write fails", async () => {
		const id = await fixture("running", `missing-${randomUUID()}`);
		await expect(runs.createRunInput(id, { content: "must roll back", mode: "steer" })).rejects.toThrow();
		expect(await db.prisma.runInput.count({ where: { runId: id } })).toBe(0);
	});

	it("persists input and transcript together", async () => {
		const conversation = await db.prisma.conversation.create({ data: {} });
		conversationIds.push(conversation.id);
		const id = await fixture("running", conversation.id);
		await runs.createRunInput(id, { content: "new direction", mode: "steer" });
		expect(await db.prisma.runInput.count({ where: { runId: id } })).toBe(1);
		expect(await db.prisma.conversationMessage.count({ where: { conversationId: conversation.id, content: "new direction" } })).toBe(1);
	});

	it("concurrent acquire yields a single owner", async () => {
		const id = await fixture("queued");
		await db.prisma.agentRun.update({
			where: { id },
			data: { leaseOwner: null, leaseToken: null, leaseUntil: null },
		});
		const [a, b] = await Promise.all([
			runs.tryAcquireRunLease(id, "owner-a"),
			runs.tryAcquireRunLease(id, "owner-b"),
		]);
		expect([a, b].filter(Boolean)).toHaveLength(1);
	});

	it("expired lease can be stolen; live lease cannot", async () => {
		const id = await fixture("running");
		expect(await runs.tryAcquireRunLease(id, "other")).toBeNull();
		await db.prisma.agentRun.update({
			where: { id },
			data: { leaseUntil: new Date(0) },
		});
		const stolen = await runs.tryAcquireRunLease(id, "other");
		expect(stolen?.owner).toBe("other");
	});
});
