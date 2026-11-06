/**
 * O papel `sleep` começa no modelo barato do deploy e só cai no modelo do bot como reserva (auditoria F5, C2).
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/sleep-llm.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Llm } from "@workspace/agent";
import type { ProviderStreamChat } from "@workspace/llm";
import type { WorkerConfig } from "./config.js";
import { V4_CHEAP_MODEL_DEFAULT } from "./engine-v4.js";
import { createSleepLlm } from "./sleep-llm.js";

const config = { openRouterApiKey: "k", openRouterModel: "m/servidor" } as unknown as WorkerConfig;

function router(unavailable: ReadonlySet<string> = new Set()) {
	const called: string[] = [];
	const streamChat = (async (params: { model: string }, handlers?: { onDelta?: (t: string) => void }) => {
		called.push(params.model);
		if (unavailable.has(params.model)) throw Object.assign(new Error("HTTP 503"), { status: 503 });
		handlers?.onDelta?.("ok");
		return { message: { role: "assistant", content: "ok" }, model: params.model, finishReason: "stop" };
	}) as unknown as ProviderStreamChat;
	return { called, streamChat };
}

const run = async (llm: Llm): Promise<void> => {
	for await (const _ of llm.chat({ role: "sleep", messages: [{ role: "user", content: "x" }] })) void _;
};

const make = (streamChat: ProviderStreamChat, env: Record<string, string | undefined> = {}) =>
	createSleepLlm({ userId: "u1", botId: "b1", policyJson: null, config, overrides: { botModel: async () => "m/do-bot", streamChat, env } });

test("sono: a primeira chamada vai ao modelo barato do deploy (ATLAS_V4_CHEAP_MODEL), não ao do bot", async () => {
	const r = router();
	await run(await make(r.streamChat, { ATLAS_V4_CHEAP_MODEL: "m/barato" }));
	assert.deepEqual(r.called, ["m/barato"]);
});

test("sono: sem a variável, o padrão do deploy é o modelo barato (Haiku)", async () => {
	const r = router();
	await run(await make(r.streamChat));
	assert.deepEqual(r.called, [V4_CHEAP_MODEL_DEFAULT]);
});

test("sono: o modelo do bot só entra como reserva, quando o barato está indisponível", async () => {
	// A saúde é por PROVEDOR: com o barato em outro provedor que o do bot, a queda dele deixa o do bot de pé.
	const r = router(new Set(["opencode-go/barato"]));
	await run(await make(r.streamChat, { ATLAS_V4_CHEAP_MODEL: "opencode-go/barato" }));
	assert.deepEqual(r.called, ["opencode-go/barato", "m/do-bot"]);
});
