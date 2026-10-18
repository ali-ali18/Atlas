import { afterEach, expect, it, vi } from "vitest";
import {
	completeChatWithTools,
	streamChatWithTools,
	chatRequestBody,
} from "./chat-tools.js";
import { withLlmStepRetry, isRetryableLlmError } from "./config.js";
import { readDecisionTimeouts } from "./decision-budget.js";
const params = {
	apiKey: "test",
	model: "model",
	tools: [],
	messages: [{ role: "user" as const, content: "hello" }],
};
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});
it("primeiro evento tem prazo mesmo quando fetch ignora signal", async () => {
	vi.useFakeTimers();
	const fetcher = vi.fn(() => new Promise<Response>(() => undefined));
	vi.stubGlobal("fetch", fetcher);
	const outcome = streamChatWithTools({
		...params,
		timeoutMs: 200,
		firstEventTimeoutMs: 30,
	}).catch((e: Error) => e);
	await vi.advanceTimersByTimeAsync(201);
	expect(await outcome).toHaveProperty("name", "TimeoutError");
	expect(fetcher).toHaveBeenCalledTimes(1);
});
it("inatividade após delta aborta sem repetir texto publicado", async () => {
	vi.useFakeTimers();
	let stream: ReadableStreamDefaultController<Uint8Array>;
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				new Response(
					new ReadableStream({
						start(c) {
							stream = c;
							c.enqueue(
								new TextEncoder().encode(
									'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
								),
							);
						},
					}),
				),
		),
	);
	const delta = vi.fn();
	const outcome = streamChatWithTools(
		{ ...params, timeoutMs: 200, idleTimeoutMs: 20 },
		{ onDelta: delta },
	).catch((e: Error) => e);
	await vi.advanceTimersByTimeAsync(21);
	expect(await outcome).toHaveProperty("name", "TimeoutError");
	expect(delta).toHaveBeenCalledTimes(1);
});
it("erro no stream antes de delta é retentado, até duas requisições", async () => {
	vi.useFakeTimers();
	let calls = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				new Response(
					calls++ === 0
						? 'data: {"error":{"message":"busy","code":503}}\n\n'
						: 'data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: [DONE]\n\n',
				),
		),
	);
	const work = streamChatWithTools(params);
	await vi.advanceTimersByTimeAsync(1300);
	expect((await work).message.content).toBe("done");
	expect(calls).toBe(2);
});
it("deadline do run reduz o prazo; cancelamento interrompe backoff", async () => {
	vi.useFakeTimers();
	vi.stubGlobal(
		"fetch",
		vi.fn(() => new Promise<Response>(() => undefined)),
	);
	const work = completeChatWithTools({
		...params,
		deadlineAtMs: Date.now() + 15,
	}).catch((e: Error) => e);
	await vi.advanceTimersByTimeAsync(16);
	expect(await work).toHaveProperty("name", "TimeoutError");
	const abort = new AbortController();
	let calls = 0;
	const retry = withLlmStepRetry(
		async () => {
			calls++;
			throw new Error("HTTP 503");
		},
		{ signal: abort.signal },
	).catch((e: Error) => e);
	await vi.advanceTimersByTimeAsync(1);
	abort.abort();
	await retry;
	expect(calls).toBe(1);
});
it("config e saída/reasoning validados; privacidade/auth nunca retentam", () => {
	expect(readDecisionTimeouts({}, {})).toEqual({
		totalMs: 90000,
		firstMs: 30000,
		idleMs: 20000,
	});
	expect(() => readDecisionTimeouts({ idleTimeoutMs: 0 }, {})).toThrow();
	expect(
		chatRequestBody(
			{ ...params, maxOutputTokens: 2048, reasoningMaxTokens: 512 },
			true,
		),
	).toMatchObject({
		max_tokens: 2048,
		reasoning: { max_tokens: 512 },
		parallel_tool_calls: true,
	});
	expect(() =>
		chatRequestBody({ ...params, maxOutputTokens: -1 }, false),
	).toThrow();
	expect(isRetryableLlmError(new Error("ZDR violation: 503 endpoints"))).toBe(
		false,
	);
	expect(isRetryableLlmError(new Error("item 500 exists"))).toBe(false);
});

it("retry não renova prazo total e nunca abre terceira requisição", async () => {
	vi.useFakeTimers();
	const fetcher = vi.fn(
		async () => new Response('{"error":{"message":"busy"}}', { status: 503 }),
	);
	vi.stubGlobal("fetch", fetcher);
	const work = completeChatWithTools({ ...params, timeoutMs: 2000 }).catch(
		(error: Error) => error,
	);
	await vi.advanceTimersByTimeAsync(2001);
	expect(await work).toHaveProperty("status", 503);
	expect(fetcher).toHaveBeenCalledTimes(2);
	fetcher.mockImplementation(() => new Promise<Response>(() => undefined));
	const deadline = completeChatWithTools({
		...params,
		timeoutMs: 1500,
		firstEventTimeoutMs: 100,
	}).catch((error: Error) => error);
	await vi.advanceTimersByTimeAsync(1501);
	expect(await deadline).toHaveProperty("name", "TimeoutError");
	expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(3);
	expect(fetcher.mock.calls.length).toBeLessThanOrEqual(4);
});

it("progressTimeoutMs: com o stream vivo o teto total sobe; depois dele aborta", async () => {
	vi.useFakeTimers();
	let stream: ReadableStreamDefaultController<Uint8Array>;
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				new Response(
					new ReadableStream({
						start(c) {
							stream = c;
							c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'));
						},
					}),
				),
		),
	);
	const outcome = streamChatWithTools({ ...params, timeoutMs: 100, progressTimeoutMs: 1000, idleTimeoutMs: 400 }).catch((e: Error) => e);
	let settled = false;
	void outcome.then(() => { settled = true; });
	// Passa do teto curto (100ms) mantendo o stream vivo.
	for (let i = 0; i < 4; i += 1) {
		await vi.advanceTimersByTimeAsync(150);
		stream!.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"b"}}]}\n\n'));
	}
	expect(settled).toBe(false);
	// Passa do teto estendido (1000ms): TimeoutError mesmo com o stream vivo.
	for (let i = 0; i < 4; i += 1) {
		await vi.advanceTimersByTimeAsync(150);
		try {
			stream!.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"c"}}]}\n\n'));
		} catch {
			// stream já cancelado pelo teto
		}
	}
	expect(await outcome).toHaveProperty("name", "TimeoutError");
});
