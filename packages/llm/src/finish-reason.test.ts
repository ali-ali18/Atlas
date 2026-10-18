import { afterEach, expect, it, vi } from "vitest";
import { completeChatWithTools, streamChatWithTools } from "./chat-tools.js";

afterEach(() => vi.unstubAllGlobals());

function sse(chunks: unknown[], options: { done?: boolean } = {}): Response {
	const encoder = new TextEncoder();
	const lines = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`);
	if (options.done !== false) lines.push("data: [DONE]\n\n");
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const line of lines) controller.enqueue(encoder.encode(line));
			controller.close();
		},
	});
	return new Response(body, { status: 200 });
}

const params = { messages: [{ role: "user" as const, content: "hi" }], model: "a/b", apiKey: "k", tools: [] };
const text = (content: string, finish?: string | null) => ({
	id: "gen-1",
	model: "a/b",
	choices: [{ delta: { content }, ...(finish !== undefined ? { finish_reason: finish } : {}) }],
});

it("keeps the finish_reason of a normal stop", async () => {
	vi.stubGlobal("fetch", vi.fn(async () => sse([text("Hello"), text("", "stop")])));
	const result = await streamChatWithTools(params);
	expect(result.message.content).toBe("Hello");
	expect(result.finishReason).toBe("stop");
});

it("keeps length (output cut) and content_filter (refusal) apart", async () => {
	vi.stubGlobal("fetch", vi.fn(async () => sse([text("Partial", "length")])));
	expect((await streamChatWithTools(params)).finishReason).toBe("length");
	vi.stubGlobal("fetch", vi.fn(async () => sse([text("No.", "content_filter")])));
	expect((await streamChatWithTools(params)).finishReason).toBe("content_filter");
});

it("a stream that ends without finish_reason is incomplete, not a normal stop", async () => {
	vi.stubGlobal("fetch", vi.fn(async () => sse([text("Half an answ")])));
	expect((await streamChatWithTools(params)).finishReason).toBe("incomplete");
});

it("EOF before [DONE] is an error, never a completed answer", async () => {
	vi.stubGlobal("fetch", vi.fn(async () => sse([text("Half an answ")], { done: false })));
	await expect(streamChatWithTools({ ...params, timeoutMs: 2000 })).rejects.toThrow(/before DONE/);
});

it("non-streaming responses carry the finish_reason too", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () =>
			new Response(JSON.stringify({ id: "g", model: "a/b", choices: [{ message: { content: "Hi" }, finish_reason: "length" }] }), { status: 200 }),
		),
	);
	expect((await completeChatWithTools(params)).finishReason).toBe("length");
});
