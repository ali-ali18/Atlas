import { describe, expect, it } from "vitest";
import { SERVER_CHECK_ERRORS, checkServer } from "./server-check";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("checkServer", () => {
	it("chama /api/auth/providers e devolve os provedores", async () => {
		let called = "";
		const result = await checkServer("https://atlas.example.com", {
			fetchImpl: async (url) => {
				called = String(url);
				return json({ github: false, google: true });
			},
		});
		expect(called).toBe("https://atlas.example.com/api/auth/providers");
		expect(result).toEqual({ ok: true, providers: { google: true, github: false } });
	});

	it("falha com mensagem clara quando não é um servidor Atlas", async () => {
		expect(await checkServer("https://x.com", { fetchImpl: async () => json({ hello: "world" }) })).toEqual({
			ok: false,
			error: SERVER_CHECK_ERRORS.notAtlas,
		});
		expect(await checkServer("https://x.com", { fetchImpl: async () => json({}, 404) })).toEqual({
			ok: false,
			error: SERVER_CHECK_ERRORS.notAtlas,
		});
		expect(await checkServer("https://x.com", { fetchImpl: async () => new Response("<html>", { status: 200 }) })).toEqual({
			ok: false,
			error: SERVER_CHECK_ERRORS.notAtlas,
		});
	});

	it("falha de rede vira mensagem de conexão", async () => {
		const result = await checkServer("https://x.com", {
			fetchImpl: async () => {
				throw new TypeError("Network request failed");
			},
		});
		expect(result).toEqual({ ok: false, error: SERVER_CHECK_ERRORS.network });
	});

	it("estoura o tempo e avisa", async () => {
		const result = await checkServer("https://x.com", {
			timeoutMs: 20,
			fetchImpl: (_url, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
				}),
		});
		expect(result).toEqual({ ok: false, error: SERVER_CHECK_ERRORS.timeout });
	});
});
