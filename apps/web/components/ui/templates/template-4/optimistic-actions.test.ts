import assert from "node:assert/strict";
import test from "node:test";
import type { Agent } from "./data";
import {
	modelFailureMessage,
	pinChangeKind,
	pinFailureMessage,
	restoreAgentFields,
	settleOptimistic,
} from "./optimistic-actions";

const base = { color: "#fff", snippet: "", time: "10:00" };
const agents: Agent[] = [
	{ ...base, id: "a1", name: "Cookie", pinned: false, openRouterModel: "openai/gpt-5" },
	{ ...base, id: "a2", name: "Zeca", pinned: true, pinOrder: 0 },
];

test("fixar que falha desfaz o otimista e avisa em português", async () => {
	let state = agents.map((agent) => (agent.id === "a1" ? { ...agent, pinned: true, pinOrder: 1 } : agent));
	const notices: string[] = [];
	const ok = await settleOptimistic({
		request: Promise.reject(new Error("500")),
		message: pinFailureMessage("Cookie", pinChangeKind({ pinned: false }, { pinned: true })),
		notify: (message) => notices.push(message),
		revert: () => {
			state = restoreAgentFields(state, "a1", { pinned: false, pinOrder: undefined });
		},
	});
	assert.equal(ok, false);
	assert.deepEqual(notices, ["Não deu para fixar o Cookie. Tente de novo."]);
	assert.equal(state.find((agent) => agent.id === "a1")?.pinned, false);
	assert.equal(state.find((agent) => agent.id === "a2")?.pinned, true);
});

test("trocar modelo que falha volta ao modelo anterior e avisa", async () => {
	let state = agents.map((agent) => (agent.id === "a1" ? { ...agent, openRouterModel: "anthropic/claude" } : agent));
	const notices: string[] = [];
	await settleOptimistic({
		request: Promise.reject(new Error("offline")),
		message: modelFailureMessage("Cookie"),
		notify: (message) => notices.push(message),
		revert: () => {
			state = restoreAgentFields(state, "a1", { openRouterModel: "openai/gpt-5" });
		},
	});
	assert.equal(state[0]?.openRouterModel, "openai/gpt-5");
	assert.deepEqual(notices, ["Não deu para trocar o modelo do Cookie. Tente de novo."]);
});

test("pedido que dá certo não desfaz nem avisa", async () => {
	let reverted = false;
	const notices: string[] = [];
	const ok = await settleOptimistic({
		request: Promise.resolve({}),
		message: "x",
		notify: (message) => notices.push(message),
		revert: () => {
			reverted = true;
		},
	});
	assert.equal(ok, true);
	assert.equal(reverted, false);
	assert.deepEqual(notices, []);
});

test("tipo de mudança de fixado: fixar, desafixar ou reordenar", () => {
	assert.equal(pinChangeKind({ pinned: false }, { pinned: true }), "pin");
	assert.equal(pinChangeKind({ pinned: true }, { pinned: false }), "unpin");
	assert.equal(pinChangeKind({ pinned: true }, { pinned: true }), "reorder");
});
