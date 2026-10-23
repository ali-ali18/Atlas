import assert from "node:assert/strict";
import { test } from "node:test";
import type { JevTelemetry, LateRunUsage, RunTelemetryMeta } from "@workspace/shared";
import { recordObserveChecks } from "./observe-checks.js";

const jev = (calls: number): JevTelemetry => ({ calls, totalMs: calls, answered: calls, unavailable: 0, inputTokens: 0, models: [], byFeature: {}, costUsd: null });

function harness() {
	const writes: Array<{ runId: string; userId: string; usage: LateRunUsage | null; telemetry?: RunTelemetryMeta }> = [];
	return {
		writes,
		deps: {
			addLateRunUsage: async (input: (typeof writes)[number]) => {
				writes.push(input);
				return true;
			},
			log: () => {},
		},
	};
}

test("grava o uso das checagens quando elas terminam, no run do dono", async () => {
	const { writes, deps } = harness();
	let release!: (usage: LateRunUsage | null) => void;
	const checks = new Promise<LateRunUsage | null>((resolve) => {
		release = resolve;
	});
	const pending = recordObserveChecks(
		{ runId: "r1", userId: "u1", observeChecks: checks, jevCallsAtCompletion: 2, jevSnapshot: () => jev(2), meta: (j) => ({ v: 1, ...(j ? { jev: j } : {}) }), hasUsage: true },
		deps,
	);
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(writes.length, 0);
	release({ promptTokens: 20, totalTokens: 24, costUsd: 0.0001 });
	await pending;
	assert.deepEqual(writes, [{ runId: "r1", userId: "u1", usage: { promptTokens: 20, totalTokens: 24, costUsd: 0.0001 } }]);
});

test("decisão do Jev depois da conclusão regrava a telemetria; sem nada novo não grava", async () => {
	const { writes, deps } = harness();
	await recordObserveChecks(
		{ runId: "r1", userId: "u1", observeChecks: Promise.resolve(null), jevCallsAtCompletion: 2, jevSnapshot: () => jev(3), meta: (j) => ({ v: 1, ...(j ? { jev: j } : {}) }), hasUsage: true },
		deps,
	);
	assert.equal(writes.length, 1);
	assert.equal(writes[0]!.usage, null);
	assert.equal(writes[0]!.telemetry?.jev?.calls, 3);
	await recordObserveChecks(
		{ runId: "r1", userId: "u1", observeChecks: Promise.resolve(null), jevCallsAtCompletion: 3, jevSnapshot: () => jev(3), meta: () => ({ v: 1 }), hasUsage: true },
		deps,
	);
	assert.equal(writes.length, 1);
	await recordObserveChecks({ runId: "r1", userId: "u1", observeChecks: undefined, jevCallsAtCompletion: 0, jevSnapshot: () => undefined, meta: () => ({ v: 1 }), hasUsage: true }, deps);
	assert.equal(writes.length, 1);
});

test("falha ao gravar nunca rejeita", async () => {
	const logged: string[] = [];
	await recordObserveChecks(
		{ runId: "r1", userId: "u1", observeChecks: Promise.resolve({ costUsd: 1 }), jevCallsAtCompletion: 0, jevSnapshot: () => undefined, meta: () => ({ v: 1 }), hasUsage: true },
		{
			addLateRunUsage: async () => {
				throw new Error("db fora");
			},
			log: (message) => logged.push(message),
		},
	);
	assert.equal(logged.length, 1);
});
