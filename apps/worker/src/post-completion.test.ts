import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { runPostCompletionSteps } from "./post-completion.js";

test("W6: falha do Redis na manutenção não propaga e não impede os demais passos", async () => {
	mock.method(console, "error", () => undefined);
	const ran: string[] = [];
	const failed = await runPostCompletionSteps("r1", [
		{
			name: "memory-review",
			run: async () => {
				throw new Error("ECONNREFUSED redis");
			},
		},
		{ name: "cost-reconcile", run: async () => void ran.push("cost-reconcile") },
		{ name: "ausente", run: undefined },
		{ name: "follow-up", run: async () => void ran.push("follow-up") },
	]);
	assert.deepEqual(failed, ["memory-review"]);
	assert.deepEqual(ran, ["cost-reconcile", "follow-up"]);
	mock.restoreAll();
});

test("W6: sem falhas devolve lista vazia e respeita a ordem", async () => {
	const order: string[] = [];
	const failed = await runPostCompletionSteps("r1", [
		{ name: "a", run: async () => void order.push("a") },
		{ name: "b", run: async () => void order.push("b") },
	]);
	assert.deepEqual(failed, []);
	assert.deepEqual(order, ["a", "b"]);
});

test("L10: passos rodam em paralelo (o tempo é o do mais lento) e a falha mantém a ordem", async () => {
	mock.method(console, "error", () => undefined);
	let running = 0;
	let peak = 0;
	const slow = (fail = false) => async () => {
		running += 1;
		peak = Math.max(peak, running);
		await new Promise((resolve) => setTimeout(resolve, 10));
		running -= 1;
		if (fail) throw new Error("boom");
	};
	const failed = await runPostCompletionSteps("r1", [
		{ name: "a", run: slow(true) },
		{ name: "b", run: slow() },
		{ name: "c", run: slow(true) },
	]);
	assert.equal(peak, 3);
	assert.deepEqual(failed, ["a", "c"]);
	mock.restoreAll();
});
