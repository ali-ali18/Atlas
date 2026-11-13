import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { respondToAgentCard } from "./atlas-api";

type Call = { url: string; method: string; body: unknown };
const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

function fakeFetch(status: number, json: unknown): Call[] {
	const calls: Call[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		calls.push({ url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
		return new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
	}) as typeof fetch;
	return calls;
}

test("aprovar e 'Agora não' vão para a rota de pedidos do run, pelo requestId", async () => {
	const calls = fakeFetch(200, { ok: true, status: "recorded", resumed: true });
	await respondToAgentCard("run 1", { kind: "approval", requestId: "req-1", callId: "c1", decision: "approve" });
	await respondToAgentCard("run 1", { kind: "approval", requestId: "req-1", callId: "c1", decision: "dismiss" });
	assert.ok(calls[0]?.url.endsWith("/v1/agent-v4/runs/run%201/requests/req-1/respond"));
	assert.equal(calls[0]?.method, "POST");
	assert.deepEqual(calls[0]?.body, { decision: "approve" });
	assert.deepEqual(calls[1]?.body, { decision: "deny" });
});

test("'Já fiz' do handoff usa o callId como chave e handoff_done", async () => {
	const calls = fakeFetch(200, { ok: true, status: "recorded", resumed: true });
	await respondToAgentCard("run-1", { kind: "handoff", callId: "call-9", decision: "done" });
	assert.ok(calls[0]?.url.endsWith("/v1/agent-v4/runs/run-1/requests/call-9/respond"));
	assert.deepEqual(calls[0]?.body, { decision: "handoff_done" });
});

test("pergunta do bot vai para a rota de cards, sem o texto da resposta", async () => {
	const calls = fakeFetch(200, { ok: true, status: "recorded" });
	await respondToAgentCard("run-1", { kind: "ask_owner", cardId: "run-1:ask:1", decision: "answer", answer: "Capa dura" });
	await respondToAgentCard("run-1", { kind: "ask_owner", cardId: "run-1:ask:1", decision: "dismiss" });
	assert.ok(calls[0]?.url.endsWith("/v1/agent-v4/cards/run-1%3Aask%3A1/respond"));
	assert.deepEqual(calls[0]?.body, { response: "answered" });
	assert.deepEqual(calls[1]?.body, { response: "dismissed" });
});

test("resposta longa demais não é enviada; erro do servidor sobe para o card", async () => {
	const calls = fakeFetch(409, { error: "conflict" });
	await assert.rejects(respondToAgentCard("run-1", { kind: "ask_owner", cardId: "k", decision: "answer", answer: "x".repeat(8_001) }));
	assert.equal(calls.length, 0);
	await assert.rejects(respondToAgentCard("run-1", { kind: "handoff", callId: "c", decision: "done" }));
});

test("resposta do cartão: repete enquanto o run ainda não estacionou (409 retryable) e entrega quando estaciona", async () => {
	const { AtlasApiError, retryWhileRunNotPaused } = await import("./atlas-api");
	let calls = 0;
	const waits: number[] = [];
	const result = await retryWhileRunNotPaused(
		async () => {
			calls += 1;
			if (calls < 3) throw new AtlasApiError("conflict", 409, { error: "run_not_paused", retryable: true });
			return { ok: true };
		},
		{ sleep: async (ms) => void waits.push(ms), waitMs: 10 },
	);
	assert.deepEqual(result, { ok: true });
	assert.equal(calls, 3);
	assert.deepEqual(waits, [10, 10]);
});

test("resposta do cartão: conflito de verdade, 404 e erro de rede sobem na hora; e desiste depois do teto de tentativas", async () => {
	const { AtlasApiError, retryWhileRunNotPaused } = await import("./atlas-api");
	const once = async (error: unknown) => {
		let calls = 0;
		await assert.rejects(
			retryWhileRunNotPaused(
				async () => {
					calls += 1;
					throw error;
				},
				{ sleep: async () => undefined },
			),
		);
		return calls;
	};
	assert.equal(await once(new AtlasApiError("conflict", 409, { error: "conflict" })), 1);
	assert.equal(await once(new AtlasApiError("Not found", 404, { error: "Not found" })), 1);
	assert.equal(await once(new Error("rede")), 1);
	let calls = 0;
	await assert.rejects(
		retryWhileRunNotPaused(
			async () => {
				calls += 1;
				throw new AtlasApiError("conflict", 409, { error: "run_not_paused", retryable: true });
			},
			{ attempts: 4, sleep: async () => undefined },
		),
	);
	assert.equal(calls, 4);
});

test("resposta do cartão: decisão gravada com o run ainda soltando o lease (retryable) repete até retomar, com teto", async () => {
	const { retryWhileResumePending } = await import("./atlas-api");
	let calls = 0;
	const waits: number[] = [];
	const result = await retryWhileResumePending(
		async () => {
			calls += 1;
			return calls < 3 ? { resumed: false, retryable: true } : { resumed: true };
		},
		{ sleep: async (ms) => void waits.push(ms), waitMs: 10 },
	);
	assert.deepEqual(result, { resumed: true });
	assert.equal(calls, 3);
	assert.deepEqual(waits, [10, 10]);
	// resposta normal (com pendência de outro pedido, ou já retomado) não repete
	let once = 0;
	await retryWhileResumePending(async () => (once += 1, { resumed: false, pending: 1 }), { sleep: async () => undefined });
	assert.equal(once, 1);
	// teto: devolve a última resposta em vez de girar para sempre
	let capped = 0;
	const last = await retryWhileResumePending(async () => (capped += 1, { resumed: false, retryable: true }), { attempts: 4, sleep: async () => undefined });
	assert.equal(capped, 4);
	assert.equal(last.retryable, true);
});
