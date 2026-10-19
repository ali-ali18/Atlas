import assert from "node:assert/strict";
import { test } from "node:test";
import { OpenRouterError, ProviderApiError, type CompleteChatResult } from "@workspace/llm";
import { MAINTENANCE_NO_KEY_MESSAGE, type AccountConfigV1 } from "@workspace/shared";
import type { WorkerConfig } from "./config.js";
import { createMaintenanceLlm, resolveMaintenanceCandidates, type MaintenanceLlmDeps } from "./maintenance-llm.js";

const config: WorkerConfig = { redisUrl: "unused", openRouterApiKey: "or-key", openRouterModel: "expensive", summarizerModel: "cheap/sum", agentRunConcurrency: 1 };
const account = (models: Record<string, string>) => ({ v: 1, models }) as unknown as AccountConfigV1;
const ok = (model: string): CompleteChatResult => ({ message: { role: "assistant", content: `ok:${model}` }, model });

function deps(over: Partial<MaintenanceLlmDeps> & { models?: Record<string, string>; keys?: string[] }): MaintenanceLlmDeps {
	return {
		loadConfig: async () => account(over.models ?? {}),
		hasKey: async (_user, provider) => (over.keys ?? []).includes(provider),
		record: async () => undefined,
		log: () => undefined,
		...over,
	};
}

test("escolhido Anthropic com chave: Anthropic primeiro, servidor como reserva", async () => {
	const { candidates } = await resolveMaintenanceCandidates({ kind: "summary", config, userId: "u" }, deps({ models: { maintenance: "anthropic-direct/claude-x" }, keys: ["anthropic"] }));
	assert.deepEqual(candidates.map((c) => [c.model, c.role]), [["anthropic-direct/claude-x", "chosen"], ["cheap/sum", "server-default"]]);
});

test("escolhido OpenCode Go com chave", async () => {
	const { candidates } = await resolveMaintenanceCandidates({ kind: "memory-review", config, userId: "u" }, deps({ models: { maintenance: "opencode-go/kimi" }, keys: ["opencode-go"] }));
	assert.equal(candidates[0]?.provider, "opencode-go");
});

test("escolhido sem chave: cai no padrão da conta (se permitido) e depois no servidor; ChatGPT nunca", async () => {
	const withDefault = await resolveMaintenanceCandidates({ kind: "summary", config, userId: "u" }, deps({ models: { maintenance: "anthropic-direct/x", default: "opencode-go/glm" }, keys: ["opencode-go"] }));
	assert.deepEqual(withDefault.candidates.map((c) => c.role), ["account-default", "server-default"]);
	const chatgptDefault = await resolveMaintenanceCandidates({ kind: "summary", config, userId: "u" }, deps({ models: { maintenance: "anthropic-direct/x", default: "chatgpt/gpt-5" } }));
	assert.deepEqual(chatgptDefault.candidates.map((c) => c.model), ["cheap/sum"]);
});

test("sem chave do servidor, com a Anthropic da conta: usa o padrão da conta", async () => {
	const { candidates } = await resolveMaintenanceCandidates({ kind: "summary", config: { ...config, openRouterApiKey: undefined }, userId: "u" }, deps({ models: { default: "anthropic-direct/claude-y" }, keys: ["anthropic"] }));
	assert.deepEqual(candidates.map((c) => c.model), ["anthropic-direct/claude-y"]);
});

test("nenhuma chave: lista vazia e a chamada falha com mensagem amigável", async () => {
	const llm = await createMaintenanceLlm({ kind: "summary", config: { ...config, openRouterApiKey: undefined }, userId: "u" }, deps({}));
	assert.equal(llm.candidates.length, 0);
	await assert.rejects(() => llm.complete({ messages: [{ role: "user", content: "x" }], model: llm.model, apiKey: "" }), { message: MAINTENANCE_NO_KEY_MESSAGE });
});

test("chave própria usa o adaptador de stream do provedor (mesmo dos runs), não o OpenRouter", async () => {
	const seen: string[] = [];
	const llm = await createMaintenanceLlm(
		{ kind: "summary", config, userId: "u" },
		deps({
			models: { maintenance: "anthropic-direct/claude-x" },
			keys: ["anthropic"],
			streams: () => ({
				anthropic: (async (params: { model: string; tools: unknown[] }) => {
					seen.push(`${params.model}|tools=${params.tools.length}`);
					return { message: { role: "assistant", content: "resumo" }, model: params.model };
				}) as never,
				opencodeGo: (async () => {
					throw new Error("não deveria");
				}) as never,
			}),
		}),
	);
	const result = await llm.complete({ messages: [{ role: "user", content: "x" }], model: "ignorado", apiKey: "ignorada" });
	assert.equal(result.message.content, "resumo");
	assert.deepEqual(seen, ["anthropic-direct/claude-x|tools=0"]);
});

test("erro de política/disponibilidade: tenta UMA vez o próximo candidato e segue nele", async () => {
	const calls: string[] = [];
	const logs: string[] = [];
	const llm = await createMaintenanceLlm(
		{ kind: "summary", config, userId: "u" },
		deps({
			models: { maintenance: "weird/model", default: "opencode-go/glm" },
			keys: ["opencode-go"],
			log: (line) => logs.push(line),
			completeChat: (async (params: { model: string; via?: (p: unknown) => Promise<unknown> }) => {
				calls.push(params.model);
				if (params.via) return params.via(params);
				throw new OpenRouterError("0 endpoints available matching your data policy (ZDR)", 404);
			}) as never,
			streams: () => ({
				anthropic: (async () => ({ message: { role: "assistant", content: "x" }, model: "m" })) as never,
				opencodeGo: (async () => {
					throw new ProviderApiError("opencode-go", 400, "bad_request");
				}) as never,
			}),
		}),
	);
	// 1ª: weird/model (OpenRouter) falha com ZDR -> 2ª: opencode-go/glm também falha (400) e NÃO há terceira tentativa.
	await assert.rejects(() => llm.complete({ messages: [{ role: "user", content: "x" }], model: "", apiKey: "" }), { status: 400 });
	assert.deepEqual(calls, ["weird/model", "opencode-go/glm"]);
	assert.equal(logs.length, 1);
	assert.match(logs[0]!, /weird\/model.*opencode-go\/glm/);
});

test("fallback bem-sucedido fica no segundo candidato nas chamadas seguintes", async () => {
	const calls: string[] = [];
	const llm = await createMaintenanceLlm(
		{ kind: "summary", config, userId: "u" },
		deps({
			models: { maintenance: "weird/model" },
			completeChat: (async (params: { model: string }) => {
				calls.push(params.model);
				if (params.model === "weird/model") throw new OpenRouterError("No endpoints found for weird/model", 404);
				return ok(params.model);
			}) as never,
		}),
	);
	const first = await llm.complete({ messages: [{ role: "user", content: "x" }], model: "", apiKey: "" });
	const second = await llm.complete({ messages: [{ role: "user", content: "x" }], model: "", apiKey: "" });
	assert.equal(first.message.content, "ok:cheap/sum");
	assert.equal(second.message.content, "ok:cheap/sum");
	assert.deepEqual(calls, ["weird/model", "cheap/sum", "cheap/sum"]);
});

test("erro transitório (503) não troca de candidato", async () => {
	const llm = await createMaintenanceLlm(
		{ kind: "summary", config, userId: "u" },
		deps({ models: { maintenance: "weird/model" }, completeChat: (async () => { throw new OpenRouterError("upstream down", 503); }) as never }),
	);
	await assert.rejects(() => llm.complete({ messages: [{ role: "user", content: "x" }], model: "", apiKey: "" }), { status: 503 });
});
