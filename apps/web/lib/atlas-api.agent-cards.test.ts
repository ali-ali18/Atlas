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
