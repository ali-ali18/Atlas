import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { prisma } from "./client.js";
import { promoteQueuedInputToSteer } from "./run-input-steer.js";

const restores: Array<() => void> = [];
function stubMethod<F extends (...args: never[]) => unknown>(target: object, name: string, implementation: F) {
	const original = Reflect.get(target, name);
	const replacement = mock.fn(implementation);
	Object.assign(target, { [name]: replacement });
	restores.push(() => Object.assign(target, { [name]: original }));
	return replacement;
}
afterEach(() => {
	for (const restore of restores.splice(0).reverse()) restore();
	mock.restoreAll();
});

const row = { id: "in1", runId: "run-a", seq: 1, author: "user", content: "faça também X", mode: "join", status: "pending", clientKey: null, createdAt: new Date("2026-01-01T00:00:00Z"), consumedAt: null };

test("Enviar agora: só promove fila pendente de run do dono", async () => {
	stubMethod(prisma.agentRun, "findFirst", async ({ where }: { where: { userId: string } }) => (where.userId === "user-a" ? { id: "run-a", status: "running" } : null));
	const update = stubMethod(prisma.runInput, "updateMany", async (_args: unknown) => ({ count: 1 }));
	stubMethod(prisma.runInput, "findUnique", async () => row);
	const record = await promoteQueuedInputToSteer("run-a", "in1", "user-a");
	assert.equal(record?.mode, "join");
	assert.deepEqual(update.mock.calls[0]?.arguments[0], { where: { id: "in1", runId: "run-a", status: "pending", mode: "queue" }, data: { mode: "join" } });
	assert.equal(await promoteQueuedInputToSteer("run-a", "in1", "user-b"), null);
});

test("Enviar agora: já consumida ou que não é fila devolve null", async () => {
	stubMethod(prisma.agentRun, "findFirst", async () => ({ id: "run-a", status: "running" }));
	stubMethod(prisma.runInput, "updateMany", async () => ({ count: 0 }));
	assert.equal(await promoteQueuedInputToSteer("run-a", "in1", "user-a"), null);
});

test("Deixar para depois: só converte join/steer pendente de run do dono", async () => {
	stubMethod(prisma.agentRun, "findFirst", async ({ where }: { where: { userId: string } }) => (where.userId === "user-a" ? { id: "run-a" } : null));
	const update = stubMethod(prisma.runInput, "updateMany", async (_args: unknown) => ({ count: 1 }));
	stubMethod(prisma.runInput, "findUnique", async () => ({ ...row, mode: "queue" }));
	const { demoteSteerInputToQueue } = await import("./run-input-steer.js");
	assert.equal((await demoteSteerInputToQueue("run-a", "in1", "user-a"))?.mode, "queue");
	assert.deepEqual(update.mock.calls[0]?.arguments[0], { where: { id: "in1", runId: "run-a", status: "pending", mode: { in: ["join", "steer"] } }, data: { mode: "queue" } });
	assert.equal(await demoteSteerInputToQueue("run-a", "in1", "user-b"), null);
});
