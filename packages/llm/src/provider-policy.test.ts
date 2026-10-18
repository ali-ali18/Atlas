import { afterEach, expect, it, vi } from "vitest";
import { streamChatWithTools } from "./chat-tools.js";

const params = { apiKey: "test", model: "model", tools: [], messages: [{ role: "user" as const, content: "hello" }] };

afterEach(() => vi.unstubAllGlobals());

it("No allowed providers no stream sem código não dispara retry", async () => {
	const fetcher = vi.fn(
		async () =>
			new Response(
				'data: {"error":{"message":"No allowed providers are available"}}\n\n',
			),
	);
	vi.stubGlobal("fetch", fetcher);
	await expect(streamChatWithTools(params)).rejects.toThrow(
		"No allowed providers",
	);
	expect(fetcher).toHaveBeenCalledTimes(1);
});

