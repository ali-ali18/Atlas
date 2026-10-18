import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchGenerationCost } from "@workspace/llm";
import { reconcileRunCosts, COST_RECONCILE_MAX_PER_RUN, type CostReconcileDeps } from "./cost-reconcile.js";

const base = { runId: "run-1", userId: "user-1", apiKey: "sk-test" };

function deps(over: Partial<CostReconcileDeps> = {}) {
	const applied: Array<{ stepId: string; costUsd: number; userId: string }> = [];
	const d: CostReconcileDeps = {
		listMissing: async () => [
			{ stepId: "s1", generationId: "g1" },
			{ stepId: "s2", generationId: "g2" },
		],
		apply: async (input) => {
			applied.push({ stepId: input.stepId, costUsd: input.costUsd, userId: input.userId });
			return true;
		},
		fetchCost: async () => ({ ok: true, costUsd: 0.5 }),
		sleep: async () => undefined,
		...over,
	};
	return { d, applied };
}

test("sucesso: aplica o custo de cada passo, escopado pelo dono", async () => {
	const { d, applied } = deps();
	const result = await reconcileRunCosts(base, d);
	assert.deepEqual(result, { checked: 2, reconciled: 2 });
	assert.deepEqual(applied, [
		{ stepId: "s1", costUsd: 0.5, userId: "user-1" },
		{ stepId: "s2", costUsd: 0.5, userId: "user-1" },
	]);
});

test("404 e timeout não aplicam nada e não lançam", async () => {
	for (const reason of ["not_found", "timeout"] as const) {
		const { d, applied } = deps({ fetchCost: async () => ({ ok: false, reason }) });
		const result = await reconcileRunCosts(base, d);
		assert.deepEqual(result, { checked: 2, reconciled: 0 });
		assert.equal(applied.length, 0);
	}
});

test("nunca lança: fetch, apply e listMissing quebrados", async () => {
	const throwing = async (): Promise<never> => {
		throw new Error("sk-test vazou");
	};
	const a = await reconcileRunCosts(base, deps({ fetchCost: throwing }).d);
	assert.deepEqual(a, { checked: 2, reconciled: 0 });
	const b = await reconcileRunCosts(base, deps({ apply: throwing }).d);
	assert.deepEqual(b, { checked: 2, reconciled: 0 });
	const c = await reconcileRunCosts(base, deps({ listMissing: throwing }).d);
	assert.deepEqual(c, { checked: 0, reconciled: 0 });
});

test("idempotente: apply devolvendo false (já reconciliado) não conta", async () => {
	const { d } = deps({ apply: async () => false });
	assert.deepEqual(await reconcileRunCosts(base, d), { checked: 2, reconciled: 0 });
});

test("limitado por run e sem consulta quando não há faltantes", async () => {
	let limit = -1;
	let fetched = 0;
	const { d } = deps({
		listMissing: async (input) => {
			limit = input.limit;
			return [];
		},
		fetchCost: async () => {
			fetched += 1;
			return { ok: true, costUsd: 1 };
		},
	});
	await reconcileRunCosts(base, d);
	assert.equal(limit, COST_RECONCILE_MAX_PER_RUN);
	assert.equal(fetched, 0);
});

test("404 inicial: espera 8s, tenta de novo após 15s e aplica quando as estatísticas saem", async () => {
	const sleeps: number[] = [];
	let calls = 0;
	const { d, applied } = deps({
		listMissing: async () => [{ stepId: "s1", generationId: "g1" }],
		sleep: async (ms) => {
			sleeps.push(ms);
		},
		fetchCost: async () => {
			calls += 1;
			return calls === 1 ? { ok: false, reason: "not_found" } : { ok: true, costUsd: 0.25 };
		},
	});
	const result = await reconcileRunCosts(base, d);
	assert.deepEqual(result, { checked: 1, reconciled: 1 });
	assert.deepEqual(sleeps, [8_000, 15_000]);
	assert.equal(calls, 2);
	assert.deepEqual(applied, [{ stepId: "s1", costUsd: 0.25, userId: "user-1" }]);
});

test("404 persistente: no máximo 2 retries e nunca lança", async () => {
	let fetched = 0;
	const { d, applied } = deps({
		listMissing: async () => [{ stepId: "s1", generationId: "g1" }],
		fetchCost: async () => {
			fetched += 1;
			return { ok: false, reason: "not_found" };
		},
	});
	const result = await reconcileRunCosts(base, d);
	assert.deepEqual(result, { checked: 1, reconciled: 0 });
	assert.equal(fetched, 3);
	assert.equal(applied.length, 0);
});

test("fake timers + fetch mockado (404 depois 200) com os atrasos reais", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const statuses = [404, 200];
	const applied: number[] = [];
	const promise = reconcileRunCosts(base, {
		listMissing: async () => [{ stepId: "s1", generationId: "g1" }],
		apply: async ({ costUsd }) => {
			applied.push(costUsd);
			return true;
		},
		fetchCost: (args) =>
			fetchGenerationCost({
				...args,
				fetchFn: (async () => new Response(JSON.stringify({ data: { total_cost: 0.1 } }), { status: statuses.shift() ?? 200 })) as typeof fetch,
			}),
	});
	for (const ms of [8_000, 15_000]) {
		for (let i = 0; i < 50; i += 1) await Promise.resolve();
		t.mock.timers.tick(ms);
	}
	const result = await promise;
	assert.deepEqual(result, { checked: 1, reconciled: 1 });
	assert.deepEqual(applied, [0.1]);
});
