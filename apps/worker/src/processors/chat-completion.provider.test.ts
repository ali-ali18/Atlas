import assert from "node:assert/strict";
import { test } from "node:test";
import { ATLAS_JOB_NAMES } from "@workspace/shared";
import type { WorkerConfig } from "../config.js";
import { processChatCompletionJob } from "./chat-completion.js";

const noOpenRouter = { redisUrl: "unused", openRouterApiKey: undefined, openRouterModel: "expensive", summarizerModel: "cheap", agentRunConcurrency: 1 } as WorkerConfig;
const job = (model: string) => ({ name: ATLAS_JOB_NAMES.chatCompletion, id: "j", data: { userId: "u1", model, messages: [{ role: "user", content: "oi" }] } }) as never;

test("chat: modelo Anthropic roda pela chave da conta, sem OpenRouter no servidor", async () => {
	const seen: string[] = [];
	const result = await processChatCompletionJob(job("anthropic-direct/claude-x"), noOpenRouter, {
		via: (async (params: { model: string }) => {
			seen.push(params.model);
			return { message: { role: "assistant", content: "olá" }, model: params.model };
		}) as never,
	});
	assert.equal(result.message.content, "olá");
	assert.deepEqual(seen, ["anthropic-direct/claude-x"]);
});

test("chat: modelo do OpenRouter sem chave no servidor continua falhando com a mensagem de sempre", async () => {
	await assert.rejects(() => processChatCompletionJob(job("vendor/model"), noOpenRouter), /OPENROUTER_API_KEY/);
});
