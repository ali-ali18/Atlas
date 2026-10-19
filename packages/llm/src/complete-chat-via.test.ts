import { describe, expect, it, vi } from "vitest";
import { createAnthropicStreamChat } from "./anthropic/stream.js";
import { completeChat } from "./openrouter.js";
import { ProviderApiError } from "./provider-errors.js";

function sse(events: unknown[]): ReadableStream<Uint8Array> {
	const text = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
	return new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(text));
			controller.close();
		},
	});
}

describe("completeChat via adaptador de provedor", () => {
	it("usa o adaptador da Anthropic dos runs (sem ferramentas) e devolve só o texto", async () => {
		const fetchMock = vi.fn(async () =>
			new Response(
				sse([
					{ type: "message_start", message: { id: "m", model: "claude-x", usage: { input_tokens: 5, output_tokens: 1 } } },
					{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
					{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "resumo pronto" } },
					{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
					{ type: "message_stop" },
				]),
				{ status: 200 },
			),
		);
		const via = createAnthropicStreamChat({ provider: "anthropic", getApiKey: async () => "sk-ant-test-1234", url: "https://anthropic.test/v1/messages", auth: "x-api-key", fetch: fetchMock as unknown as typeof fetch });
		const result = await completeChat({ messages: [{ role: "user", content: "oi" }], model: "anthropic-direct/claude-x", apiKey: "", via });
		expect(result.message.content).toBe("resumo pronto");
		expect(result.usage?.promptTokens).toBe(5);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://anthropic.test/v1/messages");
		expect(JSON.parse(String(init.body)).tools).toBeUndefined();
	});

	it("propaga o erro classificado do provedor", async () => {
		const via = vi.fn(async () => {
			throw new ProviderApiError("anthropic", 401, "auth_failed");
		});
		await expect(completeChat({ messages: [{ role: "user", content: "oi" }], model: "anthropic-direct/x", apiKey: "", via })).rejects.toMatchObject({ status: 401 });
	});

	it("resposta vazia vira erro", async () => {
		const via = vi.fn(async () => ({ message: { role: "assistant" as const, content: "" }, model: "m" }));
		await expect(completeChat({ messages: [{ role: "user", content: "oi" }], model: "anthropic-direct/x", apiKey: "", via })).rejects.toMatchObject({ status: 502 });
	});
});
