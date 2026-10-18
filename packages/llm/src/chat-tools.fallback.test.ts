import { afterEach, describe, expect, it, vi } from "vitest";
import { chatRequestBody, completeChatWithTools } from "./chat-tools.js";
import {
	isRetryableLlmError,
	readOpenRouterFallbackModels,
	withLlmStepRetry,
} from "./config.js";
import { OpenRouterError } from "./sse-stream.js";

function jsonResponse(status: number, body: unknown) {
	return new Response(JSON.stringify(body), { status });
}

describe("readOpenRouterFallbackModels", () => {
	it("lista separada por vírgula, sem vazios", () => {
		expect(
			readOpenRouterFallbackModels({
				OPENROUTER_FALLBACK_MODELS: "a/b, c/d ,,",
			} as NodeJS.ProcessEnv),
		).toEqual(["a/b", "c/d"]);
		expect(readOpenRouterFallbackModels({} as NodeJS.ProcessEnv)).toEqual(
			[],
		);
	});
});

describe("isRetryableLlmError", () => {
	it("429, 5xx e créditos valem retry; 400 e 401 não", () => {
		expect(isRetryableLlmError(new OpenRouterError("x", 429))).toBe(true);
		expect(isRetryableLlmError(new OpenRouterError("x", 503))).toBe(true);
		expect(
			isRetryableLlmError(
				new OpenRouterError("could not verify credits", 402),
			),
		).toBe(true);
		expect(isRetryableLlmError(new OpenRouterError("bad request", 400))).toBe(
			false,
		);
		expect(isRetryableLlmError(new OpenRouterError("unauthorized", 401))).toBe(
			false,
		);
	});

	it("texto do 429 upstream do OpenRouter vale retry, mesmo sem status", () => {
		const text =
			"openai/gpt-6-luna is temporarily rate-limited upstream. Please retry shortly";
		expect(isRetryableLlmError(new OpenRouterError(text, 429))).toBe(true);
		expect(isRetryableLlmError(new Error(text))).toBe(true);
	});
});

describe("withLlmStepRetry", () => {
	it("desiste após 2 tentativas e respeita retryIf", async () => {
		const sleeps: number[] = [];
		let calls = 0;
		await expect(
			withLlmStepRetry(
				async () => {
					calls += 1;
					throw new OpenRouterError("busy", 429);
				},
				{ sleep: async (ms) => void sleeps.push(ms) },
			),
		).rejects.toThrow("busy");
		expect(calls).toBe(2);
		expect(sleeps).toHaveLength(1);
		expect(sleeps[0]).toBeGreaterThanOrEqual(1000);
	});

	it("não retenta erro permanente", async () => {
		let calls = 0;
		await expect(
			withLlmStepRetry(
				async () => {
					calls += 1;
					throw new OpenRouterError("bad request", 400);
				},
				{ sleep: async () => undefined },
			),
		).rejects.toThrow("bad request");
		expect(calls).toBe(1);
	});
});

describe("completeChatWithTools + retry e fallback", () => {
	it("imagem não é enviada aos modelos de fallback de texto", () => {
		process.env.OPENROUTER_FALLBACK_MODELS = "text/one,text/two";
		const body = chatRequestBody({ model: "vision/model", apiKey: "test", tools: [], messages: [
			{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,dGVzdA==" } }] },
		] }, false);
		expect(body).not.toHaveProperty("models");
	});
	it("fallbackModels por parâmetro vence o env, filtra o próprio modelo e não vale com imagem", () => {
		process.env.OPENROUTER_FALLBACK_MODELS = "env/one";
		const body = chatRequestBody({ model: "main/model", apiKey: "test", tools: [], fallbackModels: ["user/one", "main/model"], messages: [{ role: "user", content: "oi" }] }, false);
		expect(body.models).toEqual(["main/model", "user/one"]);
		const withEnv = chatRequestBody({ model: "main/model", apiKey: "test", tools: [], messages: [{ role: "user", content: "oi" }] }, false);
		expect(withEnv.models).toEqual(["main/model", "env/one"]);
		const empty = chatRequestBody({ model: "main/model", apiKey: "test", tools: [], fallbackModels: [], messages: [{ role: "user", content: "oi" }] }, false);
		expect(empty).not.toHaveProperty("models");
		const image = chatRequestBody({ model: "v/m", apiKey: "test", tools: [], fallbackModels: ["user/one"], messages: [
			{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,dGVzdA==" } }] },
		] }, false);
		expect(image).not.toHaveProperty("models");
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		delete process.env.OPENROUTER_FALLBACK_MODELS;
	});

	it("429, 200 → sucesso com models do fallback no corpo", async () => {
		process.env.OPENROUTER_FALLBACK_MODELS = "fb/one,fb/two";
		const bodies: unknown[] = [];
		let calls = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init?: RequestInit) => {
				calls += 1;
				bodies.push(JSON.parse(String(init?.body)));
				if (calls <= 1) {
					return jsonResponse(429, { error: { message: "rate limited" } });
				}
				return jsonResponse(200, {
					model: "primary",
					choices: [{ message: { role: "assistant", content: "ok" } }],
				});
			}),
		);
		const result = await completeChatWithTools({
			messages: [{ role: "user", content: "oi" }],
			model: "primary",
			apiKey: "k",
			tools: [],
		});
		expect(calls).toBe(2);
		expect(result.message.content).toBe("ok");
		for (const body of bodies) {
			expect(body).toMatchObject({ models: ["primary", "fb/one", "fb/two"] });
		}
	}, 30_000);
});
