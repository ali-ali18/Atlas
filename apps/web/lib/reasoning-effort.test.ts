import assert from "node:assert/strict";
import test from "node:test";
import { policyWithReasoningEffort, reasoningChoicesFor, shownReasoningEffort } from "./reasoning-effort";

const withReasoning = { supportedParameters: ["tools", "reasoning"] };

function fakeStorage(broken = false) {
	const store = new Map<string, string>();
	Object.assign(globalThis, {
		window: {
			localStorage: {
				getItem: (key: string) => {
					if (broken) throw new Error("bloqueado");
					return store.get(key) ?? null;
				},
				setItem: (key: string, value: string) => {
					if (broken) throw new Error("bloqueado");
					store.set(key, value);
				},
				removeItem: (key: string) => {
					if (broken) throw new Error("bloqueado");
					store.delete(key);
				},
			},
		},
	});
	return store;
}

test("guarda por conversa do bot e apaga com Padrão do modelo", async () => {
	const store = fakeStorage();
	const { getStoredReasoningEffort, setStoredReasoningEffort } = await import("./reasoning-effort");
	assert.equal(getStoredReasoningEffort("bot-1"), undefined);
	setStoredReasoningEffort("bot-1", "low");
	setStoredReasoningEffort("bot-2", "high");
	assert.equal(getStoredReasoningEffort("bot-1"), "low");
	assert.equal(getStoredReasoningEffort("bot-2"), "high");
	setStoredReasoningEffort("bot-1", undefined);
	assert.equal(getStoredReasoningEffort("bot-1"), undefined);
	assert.equal(store.has("atlas:reasoning:bot-1"), false);
});

test("valor corrompido no storage é ignorado", async () => {
	const store = fakeStorage();
	const { getStoredReasoningEffort } = await import("./reasoning-effort");
	store.set("atlas:reasoning:bot-1", "ultra");
	assert.equal(getStoredReasoningEffort("bot-1"), undefined);
});

test("storage bloqueado não quebra: lê vazio e grava sem erro", async () => {
	fakeStorage(true);
	const { getStoredReasoningEffort, setStoredReasoningEffort } = await import("./reasoning-effort");
	assert.equal(getStoredReasoningEffort("bot-1"), undefined);
	assert.doesNotThrow(() => setStoredReasoningEffort("bot-1", "low"));
});

test("só oferece níveis ao modelo com suporte; Automático e sem suporte ficam sem controle", () => {
	assert.deepEqual(reasoningChoicesFor("anthropic/claude-sonnet-5.5", withReasoning), ["off", "low", "medium", "high"]);
	assert.deepEqual(reasoningChoicesFor("openai/gpt-5"), ["low", "medium", "high"]);
	assert.deepEqual(reasoningChoicesFor("openai/gpt-4o"), []);
	assert.deepEqual(reasoningChoicesFor("", withReasoning), []);
	assert.deepEqual(reasoningChoicesFor("chatgpt/gpt-5"), []);
});

test("a tela mostra o que o servidor vai usar", () => {
	assert.equal(shownReasoningEffort("off", "openai/gpt-5"), "low");
	assert.equal(shownReasoningEffort("off", "anthropic/claude-sonnet-5.5", withReasoning), "off");
	assert.equal(shownReasoningEffort("high", "openai/gpt-4o"), undefined);
	assert.equal(shownReasoningEffort("high", ""), undefined);
	assert.equal(shownReasoningEffort(undefined, "openai/gpt-5"), undefined);
});

test("padrão do bot parte da política mais recente, sem sobrescrever o que o chat mudou", async () => {
	const local = { engine: "v2" };
	const latest = { engine: "v2", subagentModel: "x/y", reasoningEffort: "high" };
	assert.deepEqual(await policyWithReasoningEffort("low", local, async () => latest), { engine: "v2", subagentModel: "x/y", reasoningEffort: "low" });
	assert.deepEqual(await policyWithReasoningEffort(null, local, async () => latest), { engine: "v2", subagentModel: "x/y" });
});

test("sem conseguir buscar, usa a cópia local", async () => {
	const local = { engine: "v2" };
	assert.deepEqual(await policyWithReasoningEffort("medium", local, async () => { throw new Error("offline"); }), { engine: "v2", reasoningEffort: "medium" });
});
