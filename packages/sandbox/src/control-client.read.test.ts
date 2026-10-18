import { afterEach, expect, it, vi } from "vitest";
import { controlBrowserFind, controlBrowserRead } from "./control-client.js";

afterEach(() => vi.unstubAllGlobals());

function stubFetch(body: unknown) {
	const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify(body), { status: 200 }));
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

it("read: POST /browser/read com as opções e devolve o resultado", async () => {
	const fetchMock = stubFetch({ url: "u", text: "x", totalLength: 1 });
	const result = await controlBrowserRead("sandbox", 7000, { view: "text", expand: "all", limit: 8000 });
	expect(result.text).toBe("x");
	const [url, init] = fetchMock.mock.calls[0]!;
	expect(url).toBe("http://sandbox:7000/browser/read");
	expect(JSON.parse(String(init.body))).toEqual({ view: "text", expand: "all", limit: 8000 });
});

it("find: POST /browser/find com a consulta", async () => {
	const fetchMock = stubFetch({ matches: [], total: 0 });
	await controlBrowserFind("sandbox", 7000, { query: "Week 5", regex: false });
	const [url, init] = fetchMock.mock.calls[0]!;
	expect(url).toBe("http://sandbox:7000/browser/find");
	expect(JSON.parse(String(init.body))).toEqual({ query: "Week 5", regex: false });
});

it("read: erro do controle vira SandboxControlError com a mensagem do servidor", async () => {
	vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "ref inválido" }), { status: 500 })));
	await expect(controlBrowserRead("sandbox", 7000, { expand: ["x"] })).rejects.toThrow(/ref inválido/);
});
