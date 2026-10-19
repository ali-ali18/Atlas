import { describe, expect, it, vi } from "vitest";
import { createReserveModelStream } from "./reserve-models.js";
import { ProviderApiError } from "./provider-errors.js";

const msg = [{ role: "user" as const, content: "oi" }];
const ok = (model: string) => ({ message: { role: "assistant" as const, content: "ok" }, model });

describe("lista de reserva entre provedores", () => {
	it("principal OpenRouter com reservas só do OpenRouter: passa direto (nativo)", async () => {
		const stream = vi.fn(async (p: { model: string }) => ok(p.model));
		const wrapped = createReserveModelStream(stream as never, { isAvailable: async () => true });
		await wrapped({ messages: msg, model: "a/b", apiKey: "k", tools: [], fallbackModels: ["c/d"] }, {});
		expect(stream).toHaveBeenCalledTimes(1);
		expect(stream.mock.calls[0]![0]).toMatchObject({ fallbackModels: ["c/d"] });
	});

	it("falha do principal troca para reserva de chave própria, e marca fallbackFrom", async () => {
		const stream = vi.fn(async (p: { model: string }) => {
			if (p.model === "a/b") throw new ProviderApiError("anthropic", 503, "unavailable");
			return ok(p.model);
		});
		const wrapped = createReserveModelStream(stream as never, { isAvailable: async () => true });
		const result = await wrapped({ messages: msg, model: "a/b", apiKey: "k", tools: [], fallbackModels: ["c/d", "anthropic-direct/x"] }, {});
		expect(result.model).toBe("anthropic-direct/x");
		expect(result.fallbackFrom).toBe("a/b");
		// o OpenRouter recebeu só as reservas dele
		expect(stream.mock.calls[0]![0]).toMatchObject({ fallbackModels: ["c/d"] });
	});

	it("principal Anthropic falha e cai numa reserva OpenRouter; sem chave do destino pula", async () => {
		const stream = vi.fn(async (p: { model: string }) => {
			if (p.model.startsWith("anthropic-direct/")) throw new ProviderApiError("anthropic", 529, "unavailable");
			return ok(p.model);
		});
		const wrapped = createReserveModelStream(stream as never, { isAvailable: async (m) => m !== "opencode-go/z" });
		const result = await wrapped({ messages: msg, model: "anthropic-direct/p", apiKey: "", tools: [], fallbackModels: ["opencode-go/z", "c/d"] }, {});
		expect(result.model).toBe("c/d");
		expect(stream.mock.calls.map((c) => c[0].model)).toEqual(["anthropic-direct/p", "c/d"]);
	});

	it("não troca depois de entregar texto, com aborto ou com imagem; chatgpt nunca é reserva", async () => {
		const streaming = vi.fn(async (_p: unknown, h: { onDelta?: (t: string) => void }) => {
			h.onDelta?.("a");
			throw new ProviderApiError("anthropic", 502, "stream_interrupted");
		});
		await expect(createReserveModelStream(streaming as never, { isAvailable: async () => true })({ messages: msg, model: "anthropic-direct/p", apiKey: "", tools: [], fallbackModels: ["c/d"] }, {})).rejects.toBeInstanceOf(ProviderApiError);
		expect(streaming).toHaveBeenCalledTimes(1);

		const failing = vi.fn(async () => { throw new ProviderApiError("anthropic", 503, "unavailable"); });
		const image = [{ role: "user" as const, content: [{ type: "image_url" as const, image_url: { url: "data:x" } }] }];
		await expect(createReserveModelStream(failing as never, { isAvailable: async () => true })({ messages: image, model: "anthropic-direct/p", apiKey: "", tools: [], fallbackModels: ["c/d"] }, {})).rejects.toBeDefined();
		expect(failing).toHaveBeenCalledTimes(1);

		const onlyChatgpt = vi.fn(async () => { throw new ProviderApiError("anthropic", 503, "unavailable"); });
		await expect(createReserveModelStream(onlyChatgpt as never, { isAvailable: async () => true })({ messages: msg, model: "anthropic-direct/p", apiKey: "", tools: [], fallbackModels: ["chatgpt/g"] }, {})).rejects.toBeDefined();
		expect(onlyChatgpt).toHaveBeenCalledTimes(1);
	});
});
