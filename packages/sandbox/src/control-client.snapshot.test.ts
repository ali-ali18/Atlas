import { afterEach, expect, it, vi } from "vitest";
import { controlBrowserSnapshot } from "./control-client.js";

afterEach(() => vi.unstubAllGlobals());

function stubFetch(body: unknown) {
	const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify(body), { status: 200 }));
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

it("snapshot: POST /browser/snapshot repassa engine, ref e paginação em caracteres", async () => {
	const fetchMock = stubFetch({ url: "u", title: "t", total: 2, offset: 0, limit: 6000, nextOffset: null, lines: ['[e1] button "Enviar"'], engine: "ax", tree: 'button "Enviar" [e1]', treeLength: 20 });
	const result = await controlBrowserSnapshot("sandbox", 7000, { engine: "ax", ref: "e12", area: "page", offset: 0, limit: 6000 });
	const [url, init] = fetchMock.mock.calls[0]!;
	expect(url).toBe("http://sandbox:7000/browser/snapshot");
	expect(JSON.parse(String(init.body))).toEqual({ engine: "ax", ref: "e12", area: "page", offset: 0, limit: 6000 });
	expect(result.engine).toBe("ax");
	expect(result.tree).toContain("[e1]");
	expect(result.lines).toHaveLength(1);
});

it("snapshot de imagem antiga (sem engine nem tree) continua válido", async () => {
	stubFetch({ url: "u", title: "t", total: 1, offset: 0, limit: 80, nextOffset: null, lines: ['[e1] link "Início"'] });
	const result = await controlBrowserSnapshot("sandbox", 7000, { area: "viewport" });
	expect(result.engine).toBeUndefined();
	expect(result.tree).toBeUndefined();
	expect(result.lines).toEqual(['[e1] link "Início"']);
});
