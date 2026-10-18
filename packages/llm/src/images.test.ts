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
});
