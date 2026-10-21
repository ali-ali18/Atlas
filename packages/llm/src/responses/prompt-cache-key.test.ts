import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompleteChatWithToolsParams } from "../chat-tools.js";
import { promptCacheKeyEnabled, promptCacheKeyFor, responsesRequestBody } from "./request.js";
import { createChatgptStreamChat } from "./stream.js";

const params: CompleteChatWithToolsParams = {
	model: "chatgpt/luna",
	apiKey: "never-forward",
	tools: [],
	messages: [{ role: "user", content: "Hello" }],
	sessionId: "c0123456789abcdef0123456789abcde",
};
const sse = () => new Response(readFileSync(new URL("./__fixtures__/text.sse", import.meta.url), "utf8"));

afterEach(() => vi.unstubAllEnvs());

describe("prompt_cache_key da Responses API", () => {
	it("sai por padrão, derivado do id estável da conversa, e é o mesmo entre pedidos", () => {
		const a = responsesRequestBody(params);
		const b = responsesRequestBody({ ...params, messages: [...params.messages, { role: "assistant", content: "oi" }, { role: "user", content: "e agora?" }] });
		expect(a.prompt_cache_key).toBe("c0123456789abcdef0123456789abcde");
		expect(b.prompt_cache_key).toBe(a.prompt_cache_key);
	});

	it("id fora do formato seguro vira hash, sem repetir o valor original", () => {
		const key = promptCacheKeyFor("user@example.com / conversa 1")!;
		expect(key).toMatch(/^k[0-9a-f]{31}$/);
		expect(key).not.toContain("example");
		expect(promptCacheKeyFor("user@example.com / conversa 1")).toBe(key);
		expect(promptCacheKeyFor(undefined)).toBeUndefined();
		expect(promptCacheKeyFor("  ")).toBeUndefined();
	});

	it("sem sessionId não há chave; chave de desligamento tira do corpo", () => {
		expect(responsesRequestBody({ ...params, sessionId: undefined })).not.toHaveProperty("prompt_cache_key");
		for (const off of ["0", "off", "false", "no", " OFF "]) {
			vi.stubEnv("ATLAS_PROMPT_CACHE_KEY", off);
			expect(promptCacheKeyEnabled()).toBe(false);
			expect(responsesRequestBody(params)).not.toHaveProperty("prompt_cache_key");
		}
		vi.stubEnv("ATLAS_PROMPT_CACHE_KEY", "1");
		expect(responsesRequestBody(params)).toHaveProperty("prompt_cache_key");
	});

	it("vai no corpo enviado ao plano ChatGPT e ao OpenCode Go", async () => {
		const plan = vi.fn<typeof fetch>().mockImplementation(async () => sse());
		await createChatgptStreamChat({ getAccessToken: async () => "t", fetch: plan })(params);
		expect(JSON.parse(String(plan.mock.calls[0]?.[1]?.body)).prompt_cache_key).toBe(params.sessionId);
		const go = vi.fn<typeof fetch>().mockImplementation(async () => sse());
		await createChatgptStreamChat({ getAccessToken: async () => "k", fetch: go, endpoint: { url: "https://go.example/v1/responses", slug: () => "gpt-x" } })(params);
		expect(JSON.parse(String(go.mock.calls[0]?.[1]?.body)).prompt_cache_key).toBe(params.sessionId);
	});

	it("destino que recusa a chave com 400 recebe o pedido de novo sem ela, e não leva mais a chave", async () => {
		const reject = new Response(JSON.stringify({ error: { message: "Unknown parameter: prompt_cache_key" } }), { status: 400 });
		const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(reject).mockImplementation(async () => sse());
		const endpoint = { url: "https://strict.example/v1/responses", slug: () => "gpt-x" };
		const chat = createChatgptStreamChat({ getAccessToken: async () => "k", fetch: fetchFn, endpoint });
		const result = await chat(params);
		expect(result.message.content).toBe("Hello");
		const sent = fetchFn.mock.calls.map((call) => JSON.parse(String(call[1]?.body)));
		expect(sent[0]).toHaveProperty("prompt_cache_key");
		expect(sent[1]).not.toHaveProperty("prompt_cache_key");
		await createChatgptStreamChat({ getAccessToken: async () => "k", fetch: fetchFn, endpoint })(params);
		expect(JSON.parse(String(fetchFn.mock.calls[2]?.[1]?.body))).not.toHaveProperty("prompt_cache_key");
	});
});
