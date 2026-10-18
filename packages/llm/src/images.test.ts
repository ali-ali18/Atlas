import { describe, expect, it, vi } from "vitest";
import { generateImages } from "./images.js";

describe("generateImages", () => {
	it("envia pedido único e devolve bytes e custo", async () => {
		const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
			expect(JSON.parse(String(init?.body))).toMatchObject({ model: "imagem/modelo", prompt: "logo azul", n: 1, aspect_ratio: "1:1" });
			return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("abc").toString("base64"), media_type: "image/png" }], usage: { cost: 0.04 } }), { status: 200 });
		});
		const result = await generateImages({ apiKey: "test", model: "imagem/modelo", prompt: "logo azul", n: 1, aspectRatio: "1:1", fetchFn });
		expect(result.images[0]?.bytes.toString()).toBe("abc");
		expect(result.costUsd).toBe(0.04);
		expect(fetchFn).toHaveBeenCalledTimes(1);
	});

	it("não expõe resposta ou chave em falha HTTP e não repete cobrança", async () => {
		const fetchFn = vi.fn(async () => new Response("segredo do provedor", { status: 500 }));
		await expect(generateImages({ apiKey: "chave-secreta", model: "imagem/modelo", prompt: "logo", n: 1, fetchFn })).rejects.toThrow("HTTP 500");
		expect(fetchFn).toHaveBeenCalledTimes(1);
	});

	it("cai para o chat com modalities quando /images recusa o modelo (4xx) e lê data URL", async () => {
		const png = Buffer.from("png-bytes").toString("base64");
		const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
		const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
			calls.push({ url, body: JSON.parse(String(init?.body)) });
			if (url.endsWith("/images")) return new Response(JSON.stringify({ error: { message: "model does not support images endpoint" } }), { status: 400 });
			return new Response(JSON.stringify({ choices: [{ message: { content: "ok", images: [{ type: "image_url", image_url: { url: `data:image/png;base64,${png}` } }] } }], usage: { cost: 0.03 } }), { status: 200 });
		});
		const result = await generateImages({ apiKey: "k", model: "google/gemini-image", prompt: "gato astronauta", n: 1, aspectRatio: "16:9", fetchFn });
		expect(calls[1]?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
		expect(calls[1]?.body).toMatchObject({ modalities: ["image", "text"], image_config: { aspect_ratio: "16:9" } });
		expect(result.images[0]?.bytes.toString()).toBe("png-bytes");
		expect(result.images[0]?.mime).toBe("image/png");
		expect(result.costUsd).toBe(0.03);
	});

	it("mostra a razão curta do provedor em 4xx sem corpo bruto e falha clara se o chat não devolve imagem", async () => {
		const reason = vi.fn(async () => new Response(JSON.stringify({ error: { message: "No credits" } }), { status: 402 }));
		await expect(generateImages({ apiKey: "k", model: "m/x", prompt: "p", n: 1, fetchFn: reason })).rejects.toThrow("HTTP 402). No credits");
		const noImage = vi.fn(async (url: string) => url.endsWith("/images")
			? new Response("{}", { status: 404 })
			: new Response(JSON.stringify({ choices: [{ message: { content: "só texto" } }] }), { status: 200 }));
		await expect(generateImages({ apiKey: "k", model: "m/x", prompt: "p", n: 1, fetchFn: noImage })).rejects.toThrow("modelo de geração de imagem");
	});
});
