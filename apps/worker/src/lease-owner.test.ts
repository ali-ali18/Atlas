import assert from "node:assert/strict";
import { test } from "node:test";
import { acquireRunLeaseOrYield, buildRunLeaseOwner } from "./lease-owner.js";

test("W1: owner traz worker, job e tentativa", () => {
	assert.equal(
		buildRunLeaseOwner("worker-ab", { id: "agent-run-r1", attemptsMade: 2 }, "n1"),
		"worker-ab:agent-run-r1:2:n1",
	);
});

test("W1: duas entregas do mesmo job no mesmo processo têm owners distintos", () => {
	const job = { id: "agent-run-r1", attemptsMade: 0 };
	assert.notEqual(buildRunLeaseOwner("worker-ab", job), buildRunLeaseOwner("worker-ab", job));
});

test("W1/W8: entrega duplicada com lease vigente não executa (devolve o status)", async () => {
	let holder: string | null = null;
	let executions = 0;
	const deps = {
		tryAcquire: async (_runId: string, owner: string) => {
			if (holder) return null;
			holder = owner;
			return { owner };
		},
		getState: async () => ({
			status: "running" as const,
			cancelRequested: false,
			leaseOwner: holder,
		}),
	};
	const deliver = async (nonce: string) => {
		const owner = buildRunLeaseOwner("worker-ab", { id: "agent-run-r1", attemptsMade: 0 }, nonce);
		const step = await acquireRunLeaseOrYield("r1", owner, deps);
		if (step.kind === "acquired") executions += 1;
		return step;
	};
	assert.equal((await deliver("a")).kind, "acquired");
	const duplicate = await deliver("b");
	assert.deepEqual(duplicate, { kind: "yield", result: { runId: "r1", status: "running" } });
	assert.equal(executions, 1);
});

test("W1: cancelamento pedido responde cancelled; sem dono vigente é indisponível", async () => {
	const cancelled = await acquireRunLeaseOrYield("r1", "o", {
		tryAcquire: async () => null,
		getState: async () => ({ status: "running", cancelRequested: true, leaseOwner: "x" }),
	});
	assert.deepEqual(cancelled, { kind: "yield", result: { runId: "r1", status: "cancelled" } });
	const none = await acquireRunLeaseOrYield("r1", "o", {
		tryAcquire: async () => null,
		getState: async () => ({ status: "queued", cancelRequested: false, leaseOwner: null }),
	});
	assert.deepEqual(none, { kind: "unavailable" });
});
