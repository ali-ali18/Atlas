import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { RunInputRecord } from "@workspace/shared";
import { chainFollowUp, laterFollowUpInput, planFollowUp, type FollowUpDeps } from "./follow-up.js";

let seq = 0;
function input(
	content: string,
	images = 0,
	mode: "queue" | "steer" = "queue",
): RunInputRecord {
	seq += 1;
	return {
		id: `i${seq}`,
		runId: "parent",
		seq,
		author: "user",
		content,
		...(images ? { attachments: Array.from({ length: images }, (_, n) => ({ artifactId: `a${seq}-${n}` })) } : {}),
		mode,
		status: "pending",
		clientKey: null,
		createdAt: new Date().toISOString(),
		consumedAt: null,
	};
}

test("W5: duas mensagens somando mais de 4 imagens não descartam anexo", () => {
	const first = input("olha", 3);
	const second = input("e estas", 3);
	const plan = planFollowUp([first, second], []);
	assert.ok(plan);
	assert.deepEqual(plan.consume.map((item) => item.id), [first.id]);
	assert.deepEqual(plan.defer.map((item) => item.id), [second.id]);
	assert.equal(plan.attachments.length, 3);
	assert.equal(plan.objective, "olha");
});

test("W5: funde o que cabe (queue antes de steer) e adia a partir do primeiro que estoura", () => {
	const q1 = input("a", 2);
	const q2 = input("b", 2);
	const s1 = input("c", 1, "steer");
	const s2 = input("d", 0, "steer");
	const plan = planFollowUp([q1, q2], [s1, s2]);
	assert.ok(plan);
	assert.deepEqual(plan.consume.map((item) => item.id), [q1.id, q2.id]);
	// s1 estoura (4+1) e s2 fica atrás dele: ordem preservada, nada é pulado.
	assert.deepEqual(plan.defer.map((item) => item.id), [s1.id, s2.id]);
	assert.equal(plan.attachments.length, 4);
	assert.equal(plan.objective, "a\n\nb");
});

test("W5: input só com imagem não deixa linhas em branco no objetivo", () => {
	const plan = planFollowUp([input("", 1), input("texto", 0)], []);
	assert.ok(plan);
	assert.equal(plan.objective, "texto");
	const imageOnly = planFollowUp([input("", 2)], []);
	assert.equal(imageOnly?.objective, "");
	assert.equal(imageOnly?.attachments.length, 2);
	assert.equal(planFollowUp([], []), null);
});

function harness(overrides: Partial<FollowUpDeps> = {}) {
	const calls: string[] = [];
	const pending = [input("proximo")];
	const deps: FollowUpDeps = {
		listQueued: async () => pending,
		listSteers: async () => [],
		createFollowUp: async () => {
			calls.push("create");
			return { outcome: "created", run: { id: "next" } };
		},
		announce: async () => void calls.push("announce"),
		enqueueNextRun: async (id) => {
			calls.push(`enqueue:${id}`);
			return true;
		},
		...overrides,
	};
	return { deps, calls };
}

test("W8: caminho feliz — cria, anuncia e enfileira na ordem", async () => {
	const { deps, calls } = harness();
	assert.equal(await chainFollowUp(deps), "created");
	assert.deepEqual(calls, ["create", "announce", "enqueue:next"]);
});

test("W8: crash/erro ao criar — nada é enfileirado e nada lança", async () => {
	mock.method(console, "error", () => undefined);
	const { deps, calls } = harness({
		createFollowUp: async () => {
			throw new Error("db caiu");
		},
	});
	assert.equal(await chainFollowUp(deps), "none");
	assert.deepEqual(calls, []);
	mock.restoreAll();
});

test("W8: falha ao enfileirar — run queued fica para a reconciliação, sem erro", async () => {
	const { deps, calls } = harness({
		enqueueNextRun: async () => {
			throw new Error("redis caiu");
		},
	});
	assert.equal(await chainFollowUp(deps), "enqueue_failed");
	assert.deepEqual(calls, ["create", "announce"]);
});

test("W8: reentrega depois do follow-up criado não cria nem enfileira de novo", async () => {
	const { deps, calls } = harness({
		createFollowUp: async () => ({ outcome: "already_consumed" }),
	});
	assert.equal(await chainFollowUp(deps), "already_consumed");
	assert.deepEqual(calls, []);
});

test("W8: sem inputs pendentes não faz nada", async () => {
	const { deps, calls } = harness({ listQueued: async () => [] });
	assert.equal(await chainFollowUp(deps), "none");
	assert.deepEqual(calls, []);
});

test("triagem 'later': o pedido guardado vira o objetivo do próximo turno ao concluir", async () => {
	const request = laterFollowUpInput("Send the user a short summary.", "later:in-1");
	assert.deepEqual(request, {
		content: "Send the user a short summary.",
		mode: "queue",
		author: "agent",
		clientKey: "later:in-1",
		silent: true,
	});
	let planned: Awaited<ReturnType<typeof planFollowUp>> = null;
	const { deps } = harness({
		listQueued: async () => [{ ...input(request.content), mode: "queue", author: "agent", clientKey: request.clientKey ?? null }],
		createFollowUp: async (plan) => {
			planned = plan;
			return { outcome: "created", run: { id: "next" } };
		},
	});
	assert.equal(await chainFollowUp(deps), "created");
	assert.equal(planned!.objective, "Send the user a short summary.");
});
