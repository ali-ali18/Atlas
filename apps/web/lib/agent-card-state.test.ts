import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_CARD_DECISIONS_MAX, getAgentCardDecision, resetAgentCardDecisionsForTest, setAgentCardDecision } from "./agent-card-state";

function fakeStorage() {
	const data = new Map<string, string>();
	return {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => void data.set(key, value),
		removeItem: (key: string) => void data.delete(key),
	};
}

test("decisão do card sobrevive a recarregar (lida de novo do storage) e tem teto", () => {
	Object.assign(globalThis, { localStorage: fakeStorage() });
	resetAgentCardDecisionsForTest();
	setAgentCardDecision("approval_request|run-1|req-1", "approved");
	resetAgentCardDecisionsForTest();
	assert.equal(getAgentCardDecision("approval_request|run-1|req-1"), "approved");
	assert.equal(getAgentCardDecision("outra"), null);
	for (let i = 0; i < AGENT_CARD_DECISIONS_MAX + 5; i += 1) setAgentCardDecision(`k${i}`, "dismissed");
	resetAgentCardDecisionsForTest();
	assert.equal(getAgentCardDecision("approval_request|run-1|req-1"), null);
	assert.equal(getAgentCardDecision(`k${AGENT_CARD_DECISIONS_MAX + 4}`), "dismissed");
});

test("storage corrompido ou indisponível não quebra", () => {
	const storage = fakeStorage();
	storage.setItem("atlas:agent-card-decisions", "{não é json");
	Object.assign(globalThis, { localStorage: storage });
	resetAgentCardDecisionsForTest();
	assert.equal(getAgentCardDecision("x"), null);
	Object.assign(globalThis, { localStorage: { getItem: () => { throw new Error("bloqueado"); }, setItem: () => { throw new Error("bloqueado"); } } });
	resetAgentCardDecisionsForTest();
	assert.doesNotThrow(() => setAgentCardDecision("y", "done"));
	assert.equal(getAgentCardDecision("y"), "done");
});
