import { afterEach, describe, expect, it, vi } from "vitest";
import { streamChatWithTools } from "./chat-tools.js";
import { withLlmStepRetry } from "./config.js";
import { createCallTimer, retryReasonCategory } from "./timing.js";
import { OpenRouterError } from "./sse-stream.js";

afterEach(() => vi.unstubAllGlobals());

/** Stream SSE cujo relógio avança a cada chunk lido. */
function sseResponse(chunks: unknown[], onChunk: (index: number) => void) {
	const encoder = new TextEncoder();
	let i = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (i < chunks.length) {
				onChunk(i);
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunks[i])}\n\n`));
				i += 1;
				return;
			}
			controller.enqueue(encoder.encode("data: [DONE]\n\n"));
			controller.close();
		},
	}, { highWaterMark: 0 });
	return new Response(body, { status: 200 });
}

describe("retryReasonCategory", () => {
	it("classifica sem expor a mensagem do provider", () => {
		expect(retryReasonCategory(new OpenRouterError("x", 429))).toBe("rate_limit");
		expect(retryReasonCategory(new OpenRouterError("x", 503))).toBe("server_error");
		expect(retryReasonCategory(new OpenRouterError("could not verify credits", 402))).toBe("credits");
		expect(retryReasonCategory(new Error("request timeout"))).toBe("timeout");
		expect(retryReasonCategory(new Error("boom"))).toBe("other");
	});
});

describe("withLlmStepRetry + createCallTimer", () => {
	it("conta tentativas e motivos de cada retry", async () => {
		let t = 0;
		const timer = createCallTimer("a/b", () => t);
		let calls = 0;
		await withLlmStepRetry(
			async () => {
				calls += 1;
				t += 100;
				if (calls === 1) throw new OpenRouterError("busy", 429);
				if (calls === 2) throw new OpenRouterError("down", 502);
				return "ok";
			},
			{ delays: [0, 0], sleep: async () => undefined, onRetry: timer.onRetry },
		);
		const timing = timer.finish("a/b");
		expect(timing.attempts).toBe(3);
		expect(timing.retryReasons).toEqual(["rate_limit", "server_error"]);
		expect(timing.totalMs).toBe(300);
	});
});

describe("streamChatWithTools timing", () => {
	it("captura TTFT, tempo total e modelo servido (fetch mockado)", async () => {
		let t = 1000;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				t += 200; // latência até os headers
				return sseResponse(
					[
						{ model: "served/model", choices: [{ delta: { content: "oi" } }] },
						{ choices: [{ delta: { content: " mundo" } }] },
						{ usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.001, prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 3 } } },
					],
					() => {
						t += 50;
					},
				);
			}),
		);
		const result = await streamChatWithTools({
			messages: [{ role: "user", content: "segredo do usuario" }],
			model: "requested/model",
			apiKey: "test",
			tools: [],
			clock: () => t,
		});
		expect(result.timing).toMatchObject({
			ttftMs: 250,
			totalMs: 350,
			attempts: 1,
			retryReasons: [],
			requestedModel: "requested/model",
			servedModel: "served/model",
		});
		expect(result.usage).toMatchObject({ cachedTokens: 4, cacheWriteTokens: 3, costUsd: 0.001 });
		// só metadados: nada do conteúdo vai para o timing
		expect(JSON.stringify(result.timing)).not.toContain("segredo");
		expect(JSON.stringify(result.timing)).not.toContain("mundo");
	});
});
