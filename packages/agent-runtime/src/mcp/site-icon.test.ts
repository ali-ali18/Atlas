import { beforeEach, describe, expect, it } from "vitest";
import { clearSiteIconCache, iconHostCandidates, parseIconHostname, parseIconLinks, resolveSiteIcon } from "./site-icon.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const lookupFn = async () => ["93.184.216.34"];

function fakeFetch(routes: Record<string, () => Response>) {
	const seen: string[] = [];
	const fn = (async (url: string) => {
		seen.push(url);
		const route = routes[url];
		return route ? route() : new Response("nope", { status: 404 });
	}) as never;
	return { fn, seen };
}
const img = (body: Buffer | string, type = "image/png") => () => new Response(body, { status: 200, headers: { "content-type": type } });
const html = (body: string) => () => new Response(body, { status: 200, headers: { "content-type": "text/html" } });

beforeEach(() => clearSiteIconCache());

describe("site icon", () => {
	it("candidatos de host e validação do hostname", () => {
		expect(iconHostCandidates("mcp.bling.com.br")).toEqual(["mcp.bling.com.br", "bling.com.br"]);
		expect(iconHostCandidates("api.example.com")).toEqual(["api.example.com", "example.com"]);
		expect(parseIconHostname("Example.com")).toBe("example.com");
		expect(parseIconHostname("localhost")).toBeNull();
		expect(parseIconHostname("a/b.com")).toBeNull();
	});

	it("prefere apple-touch-icon e svg ao favicon pequeno", () => {
		const links = parseIconLinks('<link rel="icon" href="/a.ico"><link rel="apple-touch-icon" sizes="180x180" href="/t.png">', "https://x.example/");
		expect(links[0]).toBe("https://x.example/t.png");
	});

	it("usa logo_uri dos metadados OAuth primeiro", async () => {
		const { fn } = fakeFetch({
			"https://srv.example/.well-known/oauth-protected-resource": () => new Response(JSON.stringify({ logo_uri: "https://srv.example/logo.png" }), { headers: { "content-type": "application/json" } }),
			"https://srv.example/logo.png": img(PNG),
		});
		const icon = await resolveSiteIcon("srv.example", { fetchFn: fn, lookupFn });
		expect(icon?.contentType).toBe("image/png");
	});

	it("cai para o <link rel=icon> da home e depois para /favicon.ico", async () => {
		const a = fakeFetch({ "https://srv.example/": html('<link rel="icon" href="/fav.png">'), "https://srv.example/fav.png": img(PNG) });
		expect((await resolveSiteIcon("srv.example", { fetchFn: a.fn, lookupFn }))?.contentType).toBe("image/png");
		clearSiteIconCache();
		const ico = Buffer.from([0, 0, 1, 0, 1, 0]);
		const b = fakeFetch({ "https://srv.example/favicon.ico": img(ico, "image/x-icon") });
		expect((await resolveSiteIcon("srv.example", { fetchFn: b.fn, lookupFn }))?.contentType).toBe("image/x-icon");
	});

	it("recusa não-imagem, imagem grande e hosts privados; guarda a ausência em cache", async () => {
		const big = Buffer.concat([PNG, Buffer.alloc(300 * 1024)]);
		const bad = fakeFetch({
			"https://srv.example/": html('<link rel="icon" href="/x.png">'),
			"https://srv.example/x.png": img(big),
			"https://srv.example/favicon.ico": img("<html>not an image</html>", "text/html"),
		});
		expect(await resolveSiteIcon("srv.example", { fetchFn: bad.fn, lookupFn })).toBeNull();
		const calls = bad.seen.length;
		expect(await resolveSiteIcon("srv.example", { fetchFn: bad.fn, lookupFn })).toBeNull();
		expect(bad.seen.length).toBe(calls);
		clearSiteIconCache();
		const priv = fakeFetch({});
		expect(await resolveSiteIcon("internal.example", { fetchFn: priv.fn, lookupFn: async () => ["10.0.0.5"] })).toBeNull();
		expect(priv.seen).toHaveLength(0);
	});
});
