import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { prisma } from "./client.js";
import { createRunInput, listPendingInterruptInputIds, listPendingSteerInputs } from "./runs.js";

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

const now = new Date("2026-01-01T00:00:00Z");

function stubCreate() {
	stubMethod(prisma.agentRun, "findUnique", async () => ({ id: "run-a", userId: "user-a", conversationId: null }));
	stubMethod(prisma, "$transaction", async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma));
	stubMethod(prisma, "$executeRaw", async () => 0);
	stubMethod(prisma.runInput, "findFirst", async () => null);
	return stubMethod(prisma.runInput, "create", async ({ data }: { data: Record<string, unknown> }) => ({
		id: "input-a",
		createdAt: now,
		consumedAt: null,
		...data,
	}));
}

test("createRunInput: sem modo vira join (padrão)", async () => {
	const write = stubCreate();
	const record = await createRunInput("run-a", { content: "oi" });
	assert.equal(write.mock.calls[0]?.arguments[0]?.data?.mode, "join");
	assert.equal(record.mode, "join");
});

test("createRunInput: steer legado vira join; redirect, interrupt e queue são preservados", async () => {
	const write = stubCreate();
	await createRunInput("run-a", { content: "a", mode: "steer" });
	assert.equal(write.mock.calls[0]?.arguments[0]?.data?.mode, "join");
	for (const mode of ["redirect", "interrupt", "queue", "cancel"] as const) {
		write.mock.resetCalls();
		await createRunInput("run-a", { content: "a", mode });
		assert.equal(write.mock.calls[0]?.arguments[0]?.data?.mode, mode);
	}
});

test("listPendingSteerInputs: busca join, redirect, interrupt e o steer legado, nunca queue", async () => {
	const find = stubMethod(prisma.runInput, "findMany", async (_args: { where: unknown }) => []);
	await listPendingSteerInputs("run-a");
	const where = find.mock.calls[0]?.arguments[0]?.where as { mode: { in: string[] } };
	assert.deepEqual([...where.mode.in].sort(), ["interrupt", "join", "redirect", "steer"]);
});

test("mapRunInput: linha antiga com mode steer segue steer (o runtime a lê como join sem classificar)", async () => {
	stubMethod(prisma.runInput, "findMany", async () => [
		{ id: "i1", runId: "run-a", seq: 1, author: "user", content: "x", mode: "steer", status: "pending", createdAt: now, consumedAt: null },
	]);
	assert.equal((await listPendingSteerInputs("run-a"))[0]?.mode, "steer");
});

test("listPendingInterruptInputIds: só interrupt pendente do run", async () => {
	const find = stubMethod(prisma.runInput, "findMany", async (_args: { where: unknown }) => [{ id: "i1" }, { id: "i2" }]);
	assert.deepEqual(await listPendingInterruptInputIds("run-a"), ["i1", "i2"]);
	assert.deepEqual(find.mock.calls[0]?.arguments[0]?.where, { runId: "run-a", status: "pending", mode: "interrupt" });
});
