import assert from "node:assert/strict";
import { test } from "node:test";
import { tickLeaseHeartbeat } from "./agent-run.js";

test("renew false → onLeaseLost (mesmo caminho do throw)", async () => {
	const errors: unknown[] = [];
	await tickLeaseHeartbeat({
		renew: async () => false,
		onLeaseLost: (error) => void errors.push(error),
	});
	assert.equal(errors.length, 1);
	assert.match(
		(errors[0] as Error)?.name ?? "",
		/LeaseLost/,
	);
});

test("renew que lança → onLeaseLost (F4: aborta igual ao !ok)", async () => {
	const errors: unknown[] = [];
	const boom = new Error("redis caiu");
	await tickLeaseHeartbeat({
		renew: async () => {
			throw boom;
		},
		onLeaseLost: (error) => void errors.push(error),
	});
	assert.deepEqual(errors, [boom]);
});

test("renew true → silencioso", async () => {
	let calls = 0;
	await tickLeaseHeartbeat({
		renew: async () => true,
		onLeaseLost: () => {
			calls += 1;
		},
	});
	assert.equal(calls, 0);
});
