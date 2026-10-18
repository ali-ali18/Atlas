import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenRouterError } from "./openrouter.js";
import { readOpenRouterSse } from "./sse-stream.js";
import { streamChatWithTools } from "./chat-tools.js";
import { streamChat } from "./openrouter.js";

function sseBody(chunks: string[], { hangAfter }: { hangAfter?: boolean } = {}) {
	let i = 0;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (i < chunks.length) {
				controller.enqueue(new TextEncoder().encode(chunks[i]));
				i += 1;
				return;
			}
			if (hangAfter) {
				await new Promise(() => undefined);
				return;
			}
			controller.close();
		},
		cancel() {
			// stream abortado pelo signal do fetch ou pelo reader.cancel
		},
	});
}

describe("readOpenRouterSse", () => {
	it("encerra no [DONE] mesmo se a conexão permanecer aberta", async () => {
		const received: unknown[] = [];
		const started = Date.now();
		await readOpenRouterSse(
			sseBody(
				[
					'data: {"choices":[{"delta":{"content":"oi"}}]}\n\n',
					"data: [DONE]\n\n",
					'data: {"choices":[{"delta":{"content":"nunca"}}]}\n\n',
				],
				{ hangAfter: true },
			),
			(chunk) => received.push(chunk),
		);
		expect(Date.now() - started).toBeLessThan(1_000);
		expect(received).toHaveLength(1);
	});

	it("erro SSE após HTTP 200 não vira sucesso", async () => {
		await expect(
			readOpenRouterSse(
				sseBody([
					'data: {"choices":[{"delta":{"content":"parcial"}}]}\n\n',
					'data: {"error":{"message":"provider overloaded"}}\n\n',
				]),
				() => undefined,
			),
		).rejects.toMatchObject({
			name: "OpenRouterError",
			message: "provider overloaded",
		});
	});
});

describe("streamChatWithTools + fetch signal", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("timeout no stream suspenso aborta a leitura do body", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init?: RequestInit) => {
				const signal = init?.signal;
				const body = new ReadableStream<Uint8Array>({
					async pull() {
						await new Promise<void>((resolve, reject) => {
							if (!signal) return;
							if (signal.aborted) {
								reject(signal.reason ?? new DOMException("aborted", "AbortError"));
								return;
							}
							signal.addEventListener("abort", () => {
								reject(
									signal.reason ?? new DOMException("aborted", "AbortError"),
								);
							});
						});
					},
				});
				return new Response(body, { status: 200 });
			}),
		);

		await expect(
			streamChatWithTools({
				messages: [{ role: "user", content: "oi" }],
				model: "test",
				apiKey: "k",
				tools: [],
				timeoutMs: 30,
			}),
		).rejects.toSatisfy((error: unknown) => {
			const name = error instanceof Error ? error.name : "";
			return name === "TimeoutError" || name === "AbortError";
		});
	});

	it("cancel do usuário durante a chamada propaga AbortError", async () => {
		const controller = new AbortController();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init?: RequestInit) => {
				const signal = init?.signal;
				if (signal?.aborted) {
					throw signal.reason ?? new DOMException("aborted", "AbortError");
				}
				const body = new ReadableStream<Uint8Array>({
					async pull() {
						await new Promise<void>((_resolve, reject) => {
							if (!signal) return;
							if (signal.aborted) {
								reject(
									signal.reason ?? new DOMException("aborted", "AbortError"),
								);
								return;
							}
							signal.addEventListener("abort", () => {
								reject(
									signal.reason ?? new DOMException("aborted", "AbortError"),
								);
							});
						});
					},
				});
				return new Response(body, { status: 200 });
			}),
		);

		const pending = streamChat(
			{
				messages: [{ role: "user", content: "oi" }],
				model: "test",
				apiKey: "k",
				signal: controller.signal,
				timeoutMs: 30_000,
			},
			{ onDelta: () => undefined },
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		controller.abort(new DOMException("user cancel", "AbortError"));
		await expect(pending).rejects.toSatisfy((error: unknown) => {
			const name = error instanceof Error ? error.name : "";
			return name === "AbortError" || name === "TimeoutError";
		});
	});

	it("[DONE] com conexão aberta não espera o socket fechar", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				const body = sseBody(
					[
						'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
						"data: [DONE]\n\n",
					],
					{ hangAfter: true },
				);
				return new Response(body, { status: 200 });
			}),
		);
		const started = Date.now();
		const result = await streamChat(
			{
				messages: [{ role: "user", content: "oi" }],
				model: "test",
				apiKey: "k",
				timeoutMs: 5_000,
			},
			{ onDelta: () => undefined },
		);
		expect(result.message.content).toBe("ok");
		expect(Date.now() - started).toBeLessThan(1_000);
	});

	it("erro SSE após 200 lança, não devolve texto parcial como sucesso", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				const body = sseBody([
					'data: {"choices":[{"delta":{"content":"parcial"}}]}\n\n',
					'data: {"error":{"message":"upstream 500"}}\n\n',
				]);
				return new Response(body, { status: 200 });
			}),
		);
		await expect(
			streamChat(
				{
					messages: [{ role: "user", content: "oi" }],
					model: "test",
					apiKey: "k",
				},
				{ onDelta: () => undefined },
			),
		).rejects.toBeInstanceOf(OpenRouterError);
	});
});
