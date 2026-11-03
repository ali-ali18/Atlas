import { describe, expect, it, vi } from "vitest";
import { createImageLoader, createLruCache } from "./image-source";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ok = () => new Response(PNG, { status: 200, headers: { "content-type": "image/png", "content-length": String(PNG.byteLength) } });
const image = (artifactId: string, uri?: string) => ({ artifactId, mime: "image/png", ...(uri ? { uri } : {}) });

describe("createLruCache", () => {
	it("o teto é por peso: item pesado expulsa os mais antigos e o que passa do teto inteiro não entra", () => {
		const cache = createLruCache<string>(10, (value) => value.length);
		cache.set("a", "1234");
		cache.set("b", "1234");
		expect(cache.weight).toBe(8);
		cache.set("c", "123456");
		expect(cache.get("a")).toBeUndefined();
		expect(cache.get("b")).toBe("1234");
		expect(cache.weight).toBe(10);
		cache.set("d", "x".repeat(11));
		expect(cache.get("d")).toBeUndefined();
		expect(cache.get("b")).toBe("1234");
		cache.set("b", "12");
		expect(cache.weight).toBe(8);
	});
	it("o mais antigo sai ao passar do limite e ler renova", () => {
		const cache = createLruCache<number>(2);
		cache.set("a", 1);
		cache.set("b", 2);
		cache.get("a");
		cache.set("c", 3);
		expect(cache.get("b")).toBeUndefined();
		expect(cache.get("a")).toBe(1);
		expect(cache.get("c")).toBe(3);
		expect(cache.size).toBe(2);
	});
});

describe("createImageLoader", () => {
	it("baixa do servidor com a sessão, devolve data URI e guarda em memória", async () => {
		const apiFetch = vi.fn(async () => ok());
		const load = createImageLoader();
		const first = await load(apiFetch, image("a1"));
		expect(first).toMatch(/^data:image\/png;base64,/);
		expect(apiFetch).toHaveBeenCalledWith("/v1/files/a1", expect.objectContaining({ signal: expect.anything() }));
		await load(apiFetch, image("a1"));
		expect(apiFetch).toHaveBeenCalledTimes(1);
	});
	it("pedidos simultâneos do mesmo arquivo baixam uma vez", async () => {
		const apiFetch = vi.fn(async () => ok());
		const load = createImageLoader();
		await Promise.all([load(apiFetch, image("a1")), load(apiFetch, image("a1"))]);
		expect(apiFetch).toHaveBeenCalledTimes(1);
	});
	it("uri local segura é usada sem rede", async () => {
		const apiFetch = vi.fn();
		const load = createImageLoader();
		expect(await load(apiFetch, image("a1", "data:image/png;base64,AAAA"))).toBe("data:image/png;base64,AAAA");
		expect(apiFetch).not.toHaveBeenCalled();
	});
	it("uri com esquema estranho é ignorada e a imagem vem do servidor", async () => {
		const apiFetch = vi.fn(async () => ok());
		const load = createImageLoader();
		expect(await load(apiFetch, image("a1", "javascript:alert(1)"))).toMatch(/^data:image\/png/);
		expect(apiFetch).toHaveBeenCalledTimes(1);
	});
	it("falha não fica guardada (a próxima tentativa baixa de novo)", async () => {
		const apiFetch = vi.fn().mockResolvedValueOnce(new Response("", { status: 404, statusText: "Not Found" })).mockResolvedValueOnce(ok());
		const load = createImageLoader();
		await expect(load(apiFetch, image("a1"))).rejects.toThrow();
		await expect(load(apiFetch, image("a1"))).resolves.toMatch(/^data:image/);
		expect(apiFetch).toHaveBeenCalledTimes(2);
	});
	it("a memória guarda só as mais recentes", async () => {
		const apiFetch = vi.fn(async () => ok());
		// Cada imagem de teste vira ~50 caracteres de data URI: 60 bytes de teto guardam uma só.
		const load = createImageLoader(60);
		await load(apiFetch, image("a"));
		await load(apiFetch, image("b"));
		await load(apiFetch, image("a"));
		expect(apiFetch).toHaveBeenCalledTimes(3);
	});
});
