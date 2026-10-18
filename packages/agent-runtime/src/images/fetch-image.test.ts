import { describe, expect, it, vi } from "vitest";
import { fetchImageFromUrl } from "./fetch-image.js";

const publicLookup = async () => ["8.8.8.8"];
const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

describe("fetchImageFromUrl", () => {
	it("lê PNG por magic bytes sem confiar no content-type", async () => {
		const fetchFn = vi.fn(async () => new Response(png, { headers: { "content-type": "text/html" } }));
		const image = await fetchImageFromUrl("https://example.com/a.png", { fetchFn, lookupFn: publicLookup });
		expect(image.bytes).toEqual(png);
	});

	it("bloqueia destino privado inclusive depois de redirect", async () => {
		const fetchFn = vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/photo.png" } }));
		await expect(fetchImageFromUrl("https://example.com/a.png", { fetchFn, lookupFn: publicLookup })).rejects.toThrow();
		expect(fetchFn).toHaveBeenCalledTimes(1);
	});

	it("bloqueia DNS privado antes de baixar", async () => {
		const fetchFn = vi.fn(async () => new Response(png));
		await expect(fetchImageFromUrl("https://private.example/a.png", { fetchFn, lookupFn: async () => ["10.1.2.3"] })).rejects.toThrow();
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("recusa HTML com extensão png e URL file", async () => {
		await expect(fetchImageFromUrl("https://example.com/a.png", { fetchFn: async () => new Response("<html>não</html>"), lookupFn: publicLookup })).rejects.toThrow("imagem válida");
		await expect(fetchImageFromUrl("file:///etc/passwd", { lookupFn: publicLookup })).rejects.toThrow();
	});
});
