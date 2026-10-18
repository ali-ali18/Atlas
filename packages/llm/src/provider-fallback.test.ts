import { describe, expect, it, vi } from "vitest";
import { createProviderFallbackStream } from "./provider-fallback.js";
import { ChatgptProviderError } from "./responses/errors.js";
import type { ProviderStreamChat } from "./provider-router.js";
const params = {
	apiKey: "fixture-key",
	model: "chatgpt/luna",
	messages: [{ role: "user" as const, content: "Hello" }],
	tools: [],
};
function fixture() {
	let at: number | null = null;
	const chatgpt = vi.fn<ProviderStreamChat>(async () => {
		throw new ChatgptProviderError(
			429,
			"subscription_sharing_usage_limit_exceeded"
		);
	});
	const openrouter = vi.fn<ProviderStreamChat>(async (p) => ({
		model: p.model,
		message: { role: "assistant", content: "done" },
		usage: { costUsd: 0.1 },
		timing: {
			requestedModel: p.model,
			servedModel: p.model,
			attempts: 1,
			retryReasons: [],
			totalMs: 10,
		},
	}));
	const notice = vi.fn();
	const deps = {
		chatgpt,
		openrouter,
		fallbackModel: "deepseek/deepseek-v4.1-flash",
		getLastLimitAt: async () => at,
		markLimitAt: async (value: number) => {
			at = value;
		},
		onFallback: notice,
		now: () => 1000,
	};
	return {
		chatgpt,
		openrouter,
		notice,
		deps,
		run: createProviderFallbackStream(deps),
		at: () => at,
	};
}
describe("fallback do plano", () => {
	it("429 antes de delta muda decisão para OR, mantém pedido e descarta providerItems", async () => {
		const f = fixture();
		const result = await f.run({
			...params,
			messages: [
				...params.messages,
				{
					role: "assistant",
					content: "old",
					providerItems: {
						provider: "chatgpt",
						model: "chatgpt/luna",
						items: [],
					},
				},
			],
		});
		expect(result.fallbackFrom).toBe("chatgpt/luna");
		expect(result.timing?.requestedModel).toBe("chatgpt/luna");
		expect(result.model).toBe("deepseek/deepseek-v4.1-flash");
		expect(f.notice).toHaveBeenCalledTimes(1);
		expect(f.at()).toBe(1000);
		expect(f.openrouter.mock.calls[0]![0].messages[1]).not.toHaveProperty(
			"providerItems"
		);
	});
	it("depois de delta nunca chama OR e não descarta texto entregue", async () => {
		const f = fixture();
		f.chatgpt.mockImplementation(async (_p, h) => {
			h?.onDelta?.("partial");
			throw new ChatgptProviderError(
				429,
				"subscription_sharing_usage_limit_exceeded"
			);
		});
		await expect(f.run(params)).rejects.toMatchObject({
			code: "subscription_sharing_usage_limit_exceeded",
		});
		expect(f.openrouter).not.toHaveBeenCalled();
		expect(f.notice).not.toHaveBeenCalled();
	});
	it("cooldown persistido entre instâncias evita chamadas e aviso repetido no mesmo run", async () => {
		const f = fixture();
		await f.run(params);
		await f.run(params);
		await createProviderFallbackStream(f.deps)(params);
		expect(f.chatgpt).toHaveBeenCalledTimes(1);
		expect(f.openrouter).toHaveBeenCalledTimes(3);
		expect(f.notice).toHaveBeenCalledTimes(2);
	});
	it("none preserva erro acionável, needs_login/indisponível elegíveis e abort não troca", async () => {
		const f = fixture();
		await expect(
			createProviderFallbackStream({ ...f.deps, fallbackModel: null })(params)
		).rejects.toMatchObject({ status: 429 });
		for (const error of [
			new ChatgptProviderError(401, "needs_login"),
			new ChatgptProviderError(503, "network_error"),
		]) {
			f.chatgpt.mockRejectedValue(error);
			await createProviderFallbackStream({
				...f.deps,
				getLastLimitAt: async () => null,
			})(params);
		}
		const controller = new AbortController();
		controller.abort();
		f.chatgpt.mockRejectedValue(new Error("cancelled"));
		await expect(
			createProviderFallbackStream({
				...f.deps,
				getLastLimitAt: async () => null,
			})({ ...params, signal: controller.signal })
		).rejects.toThrow("cancelled");
	});
});
