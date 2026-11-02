import { describe, expect, it, vi } from "vitest";
import { createApiFetch, resolveApiUrl } from "./api-fetch";

describe("resolveApiUrl", () => {
	it("resolve caminho relativo na origem do servidor", () => {
		expect(resolveApiUrl("https://atlas.test", "/v1/bots")).toBe("https://atlas.test/v1/bots");
	});
	it("recusa outro host (o cookie não pode sair daqui)", () => {
		expect(resolveApiUrl("https://atlas.test", "https://evil.test/v1/bots")).toBeNull();
		expect(resolveApiUrl("https://atlas.test", "//evil.test/x")).toBeNull();
		expect(resolveApiUrl("https://atlas.test", "http://atlas.test/x")).toBeNull();
	});
});

describe("createApiFetch", () => {
	it("manda a sessão no cabeçalho cookie e não usa o cookie do sistema", async () => {
		const fetchImpl = vi.fn(async () => new Response("{}"));
		const apiFetch = createApiFetch({ baseUrl: "https://atlas.test", getCookie: async () => "atlas.session_token=abc", fetchImpl });
		await apiFetch("/v1/bots", { headers: { accept: "application/json" } });
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://atlas.test/v1/bots");
		expect(init.credentials).toBe("omit");
		const headers = init.headers as Headers;
		expect(headers.get("cookie")).toBe("atlas.session_token=abc");
		expect(headers.get("accept")).toBe("application/json");
	});
	it("sem sessão não manda cookie", async () => {
		const fetchImpl = vi.fn(async () => new Response("{}"));
		await createApiFetch({ baseUrl: "https://atlas.test", getCookie: () => "", fetchImpl })("/v1/bots");
		expect(((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Headers).has("cookie")).toBe(false);
	});
	it("recusa chamar outro host sem chamar a rede", async () => {
		const fetchImpl = vi.fn();
		const apiFetch = createApiFetch({ baseUrl: "https://atlas.test", getCookie: () => "s=1", fetchImpl: fetchImpl as unknown as typeof fetch });
		await expect(apiFetch("https://evil.test/x")).rejects.toThrow();
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});
