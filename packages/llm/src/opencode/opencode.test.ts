import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAnthropicModels, fetchOpencodeGoModels, parseOpencodeGoModels } from "../api-key-models.js";
import type { CompleteChatWithToolsParams } from "../chat-tools.js";
import { createProviderFallbackStream } from "../provider-fallback.js";
import { ProviderApiError, classifyProviderHttpError } from "../provider-errors.js";
import type { ProviderStreamChat } from "../provider-router.js";
import { goEndpointUrl, goProtocolFor, protocolFromMetadata } from "./routing.js";
import { createOpencodeGoStreamChat } from "./stream.js";

const KEY = "go-key-SECRET-9999";
const params = (model: string): CompleteChatWithToolsParams => ({
	apiKey: "",
	model,
	tools: [],
	sessionId: "run-1",
	messages: [{ role: "user", content: "oi" }],
});

afterEach(() => {
	vi.unstubAllGlobals();
	// vitest 4: spyOn em método já espionado reaproveita o mock (e as chamadas anteriores).
	vi.restoreAllMocks();
});

describe("roteamento por família do OpenCode Go", () => {
	it("usa a tabela de prefixos da documentação", () => {
		for (const slug of ["glm-5.3", "kimi-k3", "deepseek-v4-pro", "mimo-v2.6-pro", "longcat-2.0", "hy3", "step-3"]) expect(goProtocolFor(slug)).toBe("chat");
		for (const slug of ["claude-haiku-5-5", "minimax-m3", "qwen3.8-max"]) expect(goProtocolFor(slug)).toBe("messages");
		for (const slug of ["grok-4.7", "gpt-6-luna", "muse-spark-1.3"]) expect(goProtocolFor(slug)).toBe("responses");
		expect(goProtocolFor("gemini-4-argon")).toBe("google");
	});
	it("metadado do /models tem prioridade sobre o prefixo", () => {
		expect(goProtocolFor("kimi-k3", { protocol: "responses" })).toBe("responses");
		expect(protocolFromMetadata({ npm: "@ai-sdk/anthropic" })).toBe("messages");
		expect(protocolFromMetadata({ npm: "@ai-sdk/openai-compatible" })).toBe("chat");
		expect(protocolFromMetadata({})).toBeNull();
	});
	it("monta a URL de cada endpoint e recusa google", () => {
		expect(goEndpointUrl("chat")).toBe("https://opencode.ai/inference/go/v1/chat/completions");
		expect(goEndpointUrl("messages")).toBe("https://opencode.ai/inference/go/v1/messages");
		expect(goEndpointUrl("responses")).toBe("https://opencode.ai/inference/go/v1/responses");
		expect(() => goEndpointUrl("google")).toThrow(RangeError);
	});
	it("catálogo oculta gemini e guarda o protocolo de cada modelo", () => {
		const { models, protocols } = parseOpencodeGoModels({ data: [{ id: "kimi-k3" }, { id: "gemini-4-argon" }, { id: "claude-haiku-5-5", context_length: 200000 }] });
		expect(models.map((m) => m.id)).toEqual(["opencode-go/kimi-k3", "opencode-go/claude-haiku-5-5"]);
		expect(models[1]!.contextLength).toBe(200000);
		expect(protocols).toEqual({ "kimi-k3": "chat", "claude-haiku-5-5": "messages" });
	});
});

function textSse(lines: string[]) {
	return new Response(
		new ReadableStream({
			start(c) {
				c.enqueue(new TextEncoder().encode(lines.join("")));
				c.close();
			},
		}),
		{ status: 200 },
	);
}
const chatOk = () =>
	textSse([
		'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
		'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n',
		"data: [DONE]\n\n",
	]);
const messagesOk = () =>
	textSse([
		'data: {"type":"message_start","message":{"model":"claude-haiku-5-5","usage":{"input_tokens":4}}}\n\n',
		'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
		'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ola"}}\n\n',
		'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n',
		'data: {"type":"message_stop"}\n\n',
	]);
const responsesOk = () =>
	textSse([
		'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hey"}\n\n',
		'event: response.completed\ndata: {"type":"response.completed","response":{"model":"grok-4.7","output":[{"type":"message","content":[{"type":"output_text","text":"hey"}]}],"usage":{"input_tokens":3,"output_tokens":1}}}\n\n',
	]);

describe("OpenCode Go: endpoints, cabeçalhos e segredos", () => {
	const make = (extra: Partial<Parameters<typeof createOpencodeGoStreamChat>[0]> = {}) => createOpencodeGoStreamChat({ getApiKey: async () => KEY, ...extra });

	it("chat/completions: Bearer, UA próprio, x-opencode-session, slug sem prefixo e plano", async () => {
		const fetchMock = vi.fn(async (..._args: unknown[]) => chatOk());
		vi.stubGlobal("fetch", fetchMock);
		const result = await make({ conversationId: "conv-7" })(params("opencode-go/kimi-k3"));
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://opencode.ai/inference/go/v1/chat/completions");
		const headers = init.headers as Record<string, string>;
		expect(headers.Authorization).toBe(`Bearer ${KEY}`);
		expect(headers["User-Agent"]).toMatch(/^atlas-agent\//);
		expect(headers["x-opencode-session"]).toBe("conv-7");
		const body = JSON.parse(init.body as string);
		expect(body.model).toBe("kimi-k3");
		expect(body.usage).toBeUndefined();
		expect(body.models).toBeUndefined();
		expect(JSON.stringify(result)).not.toContain(KEY);
		expect(result.message.content).toBe("ok");
		expect(result.usage).toMatchObject({ promptTokens: 5, completionTokens: 2, costKind: "plan" });
		expect(result.usage?.costUnknown).toBeUndefined();
	});

	it("sem conversationId usa o sessionId do run como sessão", async () => {
		const fetchMock = vi.fn(async (..._args: unknown[]) => chatOk());
		vi.stubGlobal("fetch", fetchMock);
		await make()(params("opencode-go/glm-5.3"));
		expect((fetchMock.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ "x-opencode-session": "run-1" });
	});

	it("messages: usa o adaptador Anthropic em /messages com chave nos dois cabeçalhos", async () => {
		const fetchMock = vi.fn(async (..._args: unknown[]) => messagesOk());
		const result = await make({ fetch: fetchMock as unknown as typeof fetch })(params("opencode-go/claude-haiku-5-5"));
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://opencode.ai/inference/go/v1/messages");
		const headers = init.headers as Record<string, string>;
		expect(headers["x-api-key"]).toBe(KEY);
		expect(headers.Authorization).toBe(`Bearer ${KEY}`);
		expect(headers["x-opencode-session"]).toBe("run-1");
		expect(headers["User-Agent"]).toMatch(/^atlas-agent\//);
		expect(JSON.parse(init.body as string).model).toBe("claude-haiku-5-5");
		expect(result.message.content).toBe("ola");
		expect(result.usage?.costKind).toBe("plan");
		expect(result.model).toBe("opencode-go/claude-haiku-5-5");
	});

	it("messages com auth configurado só por Bearer", async () => {
		const fetchMock = vi.fn(async (..._args: unknown[]) => messagesOk());
		await make({ fetch: fetchMock as unknown as typeof fetch, messagesAuth: "bearer" })(params("opencode-go/minimax-m3"));
		const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
		expect(headers["x-api-key"]).toBeUndefined();
		expect(headers.Authorization).toBe(`Bearer ${KEY}`);
	});

	it("responses: reaproveita o adaptador Responses com URL, Bearer e cabeçalhos do Go", async () => {
		const fetchMock = vi.fn(async (..._args: unknown[]) => responsesOk());
		const result = await make({ fetch: fetchMock as unknown as typeof fetch })(params("opencode-go/grok-4.7"));
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://opencode.ai/inference/go/v1/responses");
		const headers = init.headers as Record<string, string>;
		expect(headers.Authorization).toBe(`Bearer ${KEY}`);
		expect(headers["x-opencode-session"]).toBe("run-1");
		expect(headers["ChatGPT-Account-ID"]).toBeUndefined();
		expect(JSON.parse(init.body as string).model).toBe("grok-4.7");
		expect(result.message.content).toBe("hey");
		expect(result.message.providerItems).toBeUndefined();
		expect(result.model).toBe("opencode-go/grok-4.7");
	});

	it("protocolOf (metadados do /models) substitui a tabela", async () => {
		const fetchMock = vi.fn(async (..._args: unknown[]) => responsesOk());
		await make({ fetch: fetchMock as unknown as typeof fetch, protocolOf: () => "responses" })(params("opencode-go/kimi-k3"));
		expect(fetchMock.mock.calls[0]![0]).toContain("/responses");
	});

	it("gemini não é suportado", async () => {
		await expect(make()(params("opencode-go/gemini-4-argon"))).rejects.toBeInstanceOf(ProviderApiError);
	});

	it("429 vira erro de limite amigável sem eco da chave e sem retry", async () => {
		const fetchMock = vi.fn(async (..._args: unknown[]) => new Response(JSON.stringify({ error: { message: `limit for ${KEY}` } }), { status: 429 }));
		vi.stubGlobal("fetch", fetchMock);
		const error = (await make()(params("opencode-go/kimi-k3")).catch((e: unknown) => e)) as ProviderApiError;
		expect(error).toMatchObject({ code: "limit_exceeded", status: 429 });
		expect(error.message).toBe("Limite do OpenCode Go atingido.");
		expect(error.message + JSON.stringify(error)).not.toContain(KEY);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe("OpenCode Go: limite cai no modelo padrão", () => {
	function fixture(goError: unknown) {
		let at: number | null = null;
		const opencodeGo = vi.fn<ProviderStreamChat>(async () => {
			throw goError;
		});
		const openrouter = vi.fn<ProviderStreamChat>(async (p) => ({ model: p.model, message: { role: "assistant", content: "padrão" }, usage: { costUsd: 0.1 } }));
		const notices: { message: string; reason: string; from: string; to: string }[] = [];
		const run = createProviderFallbackStream({
			chatgpt: vi.fn(),
			opencodeGo,
			openrouter,
			fallbackModel: "deepseek/deepseek-v4.1-flash",
			getLastLimitAt: async () => at,
			markLimitAt: async (value) => {
				at = value;
			},
			onFallback: (n) => void notices.push(n),
			now: () => 1000,
		});
		return { run, opencodeGo, openrouter, notices, at: () => at };
	}

	it("limite: avisa em português, marca o cooldown e usa o modelo padrão", async () => {
		const f = fixture(new ProviderApiError("opencode-go", 429, "limit_exceeded"));
		const result = await f.run(params("opencode-go/kimi-k3"));
		expect(result.message.content).toBe("padrão");
		expect(result.fallbackFrom).toBe("opencode-go/kimi-k3");
		expect(f.openrouter.mock.calls[0]![0].model).toBe("deepseek/deepseek-v4.1-flash");
		expect(f.notices[0]).toMatchObject({ from: "opencode-go/kimi-k3", to: "deepseek/deepseek-v4.1-flash", message: "OpenCode Go indisponível para este modelo; usando deepseek-v4.1-flash" });
		expect(f.at()).toBe(1000);
		// Dentro do cooldown nem tenta o Go.
		await f.run(params("opencode-go/kimi-k3"));
		expect(f.opencodeGo).toHaveBeenCalledTimes(1);
	});

	it("erro que não é limite nem indisponibilidade segue como erro", async () => {
		const f = fixture(new ProviderApiError("opencode-go", 400, "bad_request"));
		await expect(f.run(params("opencode-go/kimi-k3"))).rejects.toMatchObject({ code: "bad_request" });
		expect(f.openrouter).not.toHaveBeenCalled();
	});

	it("modelos Anthropic e OpenRouter não passam pelo fallback do Go", async () => {
		const f = fixture(new ProviderApiError("opencode-go", 429, "limit_exceeded"));
		await f.run(params("deepseek/deepseek-v4.1-flash"));
		expect(f.opencodeGo).not.toHaveBeenCalled();
	});
});

describe("catálogos por chave", () => {
	it("Anthropic: GET /v1/models com x-api-key e prefixo anthropic-direct/", async () => {
		const fetchMock = vi.fn(async (..._args: unknown[]) => new Response(JSON.stringify({ data: [{ id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5" }], has_more: false }), { status: 200 }));
		const models = await fetchAnthropicModels(KEY, { fetch: fetchMock as unknown as typeof fetch });
		expect(models).toMatchObject([{ id: "anthropic-direct/claude-sonnet-5-5", name: "Claude Sonnet 5.5", provider: "anthropic" }]);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toContain("https://api.anthropic.com/v1/models");
		expect(init.headers).toMatchObject({ "x-api-key": KEY, "anthropic-version": "2023-06-01" });
	});
	it("OpenCode Go: GET /models com Bearer; 401 vira auth_failed", async () => {
		const ok = vi.fn(async (..._args: unknown[]) => new Response(JSON.stringify({ data: [{ id: "glm-5.3" }] }), { status: 200 }));
		const { models } = await fetchOpencodeGoModels(KEY, { fetch: ok as unknown as typeof fetch });
		expect(models[0]!.id).toBe("opencode-go/glm-5.3");
		expect((ok.mock.calls[0] as unknown as [string, RequestInit])[0]).toBe("https://opencode.ai/inference/go/v1/models");
		const denied = vi.fn(async (..._args: unknown[]) => new Response("{}", { status: 401 }));
		await expect(fetchOpencodeGoModels(KEY, { fetch: denied as unknown as typeof fetch })).rejects.toMatchObject({ code: "auth_failed" });
	});
});

describe("400 com imagem no OpenCode Go", () => {
	const withImage = (model: string): CompleteChatWithToolsParams => ({
		...params(model),
		messages: [{ role: "user", content: [{ type: "text", text: "o que é isto?" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }],
	});
	const chatBody = () => textSse(['data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n', "data: [DONE]\n\n"]);

	it("repete uma vez sem as imagens quando o modelo recusa com 400", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const bodies: string[] = [];
		const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
			bodies.push(String(init?.body));
			return bodies.length === 1 ? new Response(JSON.stringify({ error: { message: "bad input" } }), { status: 400 }) : chatBody();
		});
		const chat = createOpencodeGoStreamChat({ getApiKey: async () => KEY, fetch: fetchMock as unknown as typeof fetch });
		vi.stubGlobal("fetch", fetchMock);
		const result = await chat(withImage("opencode-go/glm-5.3"));
		expect(result.message.content).toBe("ok");
		expect(bodies).toHaveLength(2);
		expect(bodies[0]).toContain("image_url");
		expect(bodies[1]).not.toContain("image_url");
		expect(bodies[1]).toContain("this model does not accept images");
		expect(bodies.join("")).not.toContain(KEY);
	});

	it("400 sem imagem na requisição segue como erro (sem repetir)", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const fetchMock = vi.fn(async () => new Response("{}", { status: 400 }));
		vi.stubGlobal("fetch", fetchMock);
		const chat = createOpencodeGoStreamChat({ getApiKey: async () => KEY });
		await expect(chat(params("opencode-go/glm-5.3"))).rejects.toMatchObject({ code: "bad_request" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("corpo que fala de imagem vira mensagem curta com o motivo; o corpo vai ao log sem a chave", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const error = classifyProviderHttpError("opencode-go", 400, { error: { message: "model does not support image input", detail: `Bearer ${KEY}` } });
		expect(error.reason).toBe("no_image_support");
		expect(error.message).toBe("OpenCode Go: este modelo não lê imagens. Escolha um modelo com visão ou envie sem a imagem.");
		const logged = String(warn.mock.calls[0]?.[0]);
		expect(logged).toContain("does not support image input");
		expect(logged).not.toContain(KEY);
		expect(classifyProviderHttpError("opencode-go", 400, { error: { message: "temperature invalid" } }).reason).toBeUndefined();
	});
});
