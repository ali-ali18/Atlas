/** Cards do motor v4 gravados na conversa: uma vez por identidade, sem segredo, escopados por dono, com o estado derivado na leitura. */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { agentCardKey, parseAgentV4Event } from "@workspace/shared";
import { attachAgentV4CardStates, persistAgentV4Card } from "./agent-v4-cards.js";
import { prisma } from "./client.js";
import { FakeTable, installFakes } from "./testing/fake-tables.js";

let messages: FakeTable;
let runs: FakeTable;
let requests: FakeTable;
let offers: FakeTable;
let conversations: FakeTable;
let installed: { restore: () => void };

beforeEach(() => {
	messages = new FakeTable([], () => ({ createdAt: new Date() }));
	runs = new FakeTable([
		{ id: "run-1", userId: "user-a", conversationId: "conv-a", status: "paused" },
		{ id: "run-b", userId: "user-b", conversationId: "conv-b", status: "paused" },
	]);
	requests = new FakeTable([]);
	offers = new FakeTable([]);
	conversations = new FakeTable([
		{ id: "conv-a", userId: "user-a" },
		{ id: "conv-b", userId: "user-b" },
	]);
	installed = installFakes({ conversationMessage: messages, agentRun: runs, agentV4Request: requests, agentConversationOffer: offers, conversation: conversations });
});
afterEach(() => installed.restore());

const NOW = new Date("2026-11-12T12:00:00Z");
const LATER = new Date("2026-11-13T12:00:00Z");
const approval = { type: "approval_request" as const, requestId: "req-1", callId: "call-1", toolName: "send_email", effect: "send" as const, args: { to: "ana@x.test" }, riskFacts: { recipients: ["ana@x.test"] }, runId: "run-1" };
const handoff = { type: "handoff_request" as const, callId: "call-2", message: "Troque a senha.", runId: "run-1" };
const ask = { type: "ask_owner" as const, cardId: "run-1:ask:1", question: "Qual prazo?", runId: "run-1" };
const receipt = { type: "receipt" as const, id: "call-3", name: "create_event", what: "Evento criado", runId: "run-1" };

const rows = async () => (await messages.findMany({})) as Array<{ id: string; role: string; content: string; runId: string }>;

test("grava um card de cada tipo, com role = tipo e o evento em JSON, uma vez só", async () => {
	for (const event of [approval, approval, handoff, ask, ask, receipt, receipt]) await persistAgentV4Card("user-a", "conv-a", event);
	const saved = await rows();
	assert.deepEqual(saved.map((r) => r.role).sort(), ["approval_request", "ask_owner", "handoff_request", "receipt"]);
	for (const row of saved) {
		const event = parseAgentV4Event(JSON.parse(row.content));
		assert.ok(event);
		assert.equal(row.runId, "run-1");
	}
	// mesma chave do ao vivo
	const stored = parseAgentV4Event(JSON.parse(saved.find((r) => r.role === "approval_request")!.content))!;
	assert.equal(agentCardKey(stored), agentCardKey(approval));
});

test("o mesmo pedido de outro run é outro card", async () => {
	runs.rows.push({ id: "run-2", userId: "user-a", conversationId: "conv-a", status: "paused" });
	await persistAgentV4Card("user-a", "conv-a", approval);
	await persistAgentV4Card("user-a", "conv-a", { ...approval, runId: "run-2" });
	assert.equal((await rows()).length, 2);
});

test("card de compra: o CVV não é gravado nem por argumento, nem por fato de risco", async () => {
	const buy = { ...approval, toolName: "checkout", effect: "money" as const, ownerInput: "card_cvv" as const, args: { url: "https://loja.test/pay", cvv: "123" }, riskFacts: { amount: 10, currency: "BRL", merchant: "loja.test", card: "Visa final 1111", cvv: "123", cardNumber: "4111111111111111" } };
	await persistAgentV4Card("user-a", "conv-a", buy);
	const [row] = await rows();
	assert.ok(row);
	assert.equal(row.content.includes("123"), false);
	assert.equal(row.content.includes("4111111111111111"), false);
	assert.match(row.content, /card_cvv/);
});

test("escopo: conversa ou run de outro dono, ou sem runId, não grava", async () => {
	assert.equal(await persistAgentV4Card("user-b", "conv-a", approval), "skipped");
	assert.equal(await persistAgentV4Card("user-a", "conv-b", { ...approval, runId: "run-b" }), "skipped");
	assert.equal(await persistAgentV4Card("user-a", "conv-a", { ...approval, runId: "run-b" }), "skipped");
	assert.equal(await persistAgentV4Card("user-a", "conv-a", { ...approval, runId: undefined }), "skipped");
	assert.equal(await persistAgentV4Card("user-a", null, approval), "skipped");
	assert.equal(await persistAgentV4Card("user-a", "conv-a", { type: "assistant_delta", id: "x", delta: "y" }), "skipped");
	assert.equal((await rows()).length, 0);
});

async function persistedRows() {
	for (const event of [approval, handoff, ask, receipt]) await persistAgentV4Card("user-a", "conv-a", event);
	return rows();
}
const stateOf = (map: Map<string, string>, all: Array<{ id: string; role: string }>, role: string) => map.get(all.find((r) => r.role === role)!.id);

test("estado: pedidos pendentes dentro do prazo; recibo não tem estado", async () => {
	const all = await persistedRows();
	requests.rows.push({ userId: "user-a", runId: "run-1", kind: "approval", key: "req-1", state: "pending", expiresAt: LATER }, { userId: "user-a", runId: "run-1", kind: "handoff", key: "call-2", state: "pending", expiresAt: LATER });
	offers.rows.push({ conversationId: "conv-a", cardId: ask.cardId, state: "open" });
	const states = await attachAgentV4CardStates("conv-a", all, NOW);
	assert.equal(stateOf(states, all, "approval_request"), "pending");
	assert.equal(stateOf(states, all, "handoff_request"), "pending");
	assert.equal(stateOf(states, all, "ask_owner"), "pending");
	assert.equal(stateOf(states, all, "receipt"), undefined);
});

test("estado: aprovado, dispensado, feito, respondido", async () => {
	const all = await persistedRows();
	requests.rows.push({ userId: "user-a", runId: "run-1", kind: "approval", key: "req-1", state: "denied", expiresAt: LATER }, { userId: "user-a", runId: "run-1", kind: "handoff", key: "call-2", state: "done", expiresAt: LATER }, { userId: "user-a", runId: "run-1", kind: "card", key: ask.cardId, state: "dismissed", expiresAt: null });
	offers.rows.push({ conversationId: "conv-a", cardId: ask.cardId, state: "open" });
	const states = await attachAgentV4CardStates("conv-a", all, NOW);
	assert.equal(stateOf(states, all, "approval_request"), "denied");
	assert.equal(stateOf(states, all, "handoff_request"), "done");
	assert.equal(stateOf(states, all, "ask_owner"), "dismissed");
	requests.rows[0]!.state = "approved";
	assert.equal(stateOf(await attachAgentV4CardStates("conv-a", all, NOW), all, "approval_request"), "approved");
});

test("estado: venceu (24 h) ou o run terminou sem decisão = expirado, nunca botão", async () => {
	const all = await persistedRows();
	requests.rows.push({ userId: "user-a", runId: "run-1", kind: "approval", key: "req-1", state: "pending", expiresAt: new Date("2026-11-12T11:00:00Z") });
	assert.equal(stateOf(await attachAgentV4CardStates("conv-a", all, NOW), all, "approval_request"), "expired");
	runs.rows[0]!.status = "cancelled";
	const ended = await attachAgentV4CardStates("conv-a", all, NOW);
	assert.equal(stateOf(ended, all, "handoff_request"), "expired");
});

test("escopo na leitura: run de outra conversa no conteúdo não dá estado de outro dono", async () => {
	requests.rows.push({ userId: "user-b", runId: "run-b", kind: "approval", key: "req-1", state: "approved", expiresAt: LATER });
	const forged = { id: "m-forged", role: "approval_request", content: JSON.stringify({ ...approval, runId: "run-b" }) };
	const states = await attachAgentV4CardStates("conv-a", [forged], NOW);
	assert.equal(states.get("m-forged"), "expired");
	// e não consulta nada quando a página não tem card v4
	assert.equal((await attachAgentV4CardStates("conv-a", [{ id: "u", role: "user", content: "oi" }], NOW)).size, 0);
	void prisma;
});
