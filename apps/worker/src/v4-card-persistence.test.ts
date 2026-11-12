/**
 * Cards do motor v4 na conversa: o worker grava os quatro tipos, uma vez, sem derrubar o run se o banco falhar.
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/v4-card-persistence.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ComputerUseEvent } from "@workspace/shared";
import { withV4CardPersistence } from "./v4-card-persistence.js";

const cards: ComputerUseEvent[] = [
	{ type: "approval_request", requestId: "r1", callId: "c1", toolName: "send_email", effect: "send", args: {}, riskFacts: {}, runId: "run-1" },
	{ type: "handoff_request", callId: "c2", message: "Troque a senha.", runId: "run-1" },
	{ type: "ask_owner", cardId: "run-1:ask:1", question: "Qual prazo?", runId: "run-1" },
	{ type: "receipt", id: "c3", name: "create_event", what: "Evento criado", runId: "run-1" },
];

test("grava cada card v4 na conversa do run e deixa passar os demais eventos sem gravar", async () => {
	const emitted: string[] = [];
	const saved: Array<[string, string, unknown]> = [];
	const emit = withV4CardPersistence({ userId: "u1", runId: "run-1", conversationId: "conv-1", persist: async (u, c, e) => (saved.push([u, c as string, e]), "created") }, (e) => void emitted.push(e.type));
	for (const card of cards) await emit(card);
	await emit({ type: "assistant_delta", id: "x", delta: "oi" });
	await emit({ type: "tool_call", id: "t", name: "n", args: "{}", step: 1 });
	assert.equal(emitted.length, 6);
	assert.deepEqual(saved.map(([, , e]) => (e as { type: string }).type), ["approval_request", "handoff_request", "ask_owner", "receipt"]);
	assert.ok(saved.every(([u, c]) => u === "u1" && c === "conv-1"));
});

test("card sem runId herda o do run", async () => {
	const saved: unknown[] = [];
	const emit = withV4CardPersistence({ userId: "u1", runId: "run-9", conversationId: "conv-1", persist: async (_u, _c, e) => (saved.push(e), "created") }, () => undefined);
	await emit({ type: "handoff_request", callId: "c2", message: "Faça." });
	assert.equal((saved[0] as { runId: string }).runId, "run-9");
});

test("sem conversa não grava; falha de banco só vai para o log e o evento já foi emitido", async () => {
	let calls = 0;
	const emitted: string[] = [];
	const logs: string[] = [];
	const none = withV4CardPersistence({ userId: "u1", runId: "run-1", conversationId: null, persist: async () => (calls++, "created") }, (e) => void emitted.push(e.type));
	await none(cards[0]!);
	assert.equal(calls, 0);
	const failing = withV4CardPersistence(
		{
			userId: "u1",
			runId: "run-1",
			conversationId: "conv-1",
			persist: async () => {
				throw new Error("db caiu com segredo 4111111111111111");
			},
			log: (m) => void logs.push(m),
		},
		(e) => void emitted.push(e.type),
	);
	await failing(cards[3]!);
	assert.deepEqual(emitted, ["approval_request", "receipt"]);
	assert.equal(logs.length, 1);
	assert.equal(logs[0]!.includes("4111"), false);
});
