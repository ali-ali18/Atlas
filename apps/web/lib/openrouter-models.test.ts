import assert from "node:assert/strict";
import test from "node:test";

function fakeSession() {
	const store = new Map<string, string>();
	Object.assign(globalThis, {
		window: {},
		sessionStorage: {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => void store.set(key, value),
		},
	});
}

test("modelo do composer: bot fixa o modelo; sem nada, Automático (vazio)", async () => {
	fakeSession();
	const { resolveAgentModel } = await import("./openrouter-models");
	assert.equal(resolveAgentModel("bot-1", "vendor/model-a"), "vendor/model-a");
	assert.equal(resolveAgentModel("bot-1", undefined), "");
	assert.equal(resolveAgentModel("bot-1", "  "), "");
});

test("modelo do composer: escolha da sessão vale; escolher Automático depois vence o modelo do bot", async () => {
	fakeSession();
	const { resolveAgentModel, setStoredAgentModel } = await import("./openrouter-models");
	setStoredAgentModel("bot-2", "vendor/model-b");
	assert.equal(resolveAgentModel("bot-2", undefined), "vendor/model-b");
	setStoredAgentModel("bot-2", "");
	assert.equal(resolveAgentModel("bot-2", "vendor/model-a"), "", "Automático escolhido na sessão");
	setStoredAgentModel("bot-2", "vendor/model-c");
	assert.equal(resolveAgentModel("bot-2", "vendor/model-a"), "vendor/model-a", "escolher um modelo desfaz o Automático");
});
