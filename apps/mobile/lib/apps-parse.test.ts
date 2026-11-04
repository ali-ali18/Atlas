import { describe, expect, it } from "vitest";
import { allowsHttp, browserUrl, parseComposioCategories, parseComposioConfigured, parseComposioConnections, parseComposioPage, parseConnectResult, parseMcpCatalog, parseMcpConnections, pickBrowserUrl, safeLogoUrl } from "./apps-parse";

const entry = { id: "github", name: "GitHub", description: "Repos", longDescription: "Repos e issues", category: "productivity", icon: "/connectors/github.svg", authType: "oauth", availability: "available", skills: [{ key: "a", title: "Ler issues", description: "x" }, { key: "b" }], oauthReady: true, connectionId: "c1", status: "connected", accountCount: 2 };

describe("parseMcpCatalog", () => {
	it("lê as entradas e o estado da conexão", () => {
		const [github] = parseMcpCatalog({ entries: [entry], secretBoxReady: true })!;
		expect(github).toMatchObject({ id: "github", comingSoon: false, status: "connected", connectionId: "c1", accountCount: 2, oauthReady: true, apiKey: null });
		expect(github!.skills).toEqual([{ key: "a", title: "Ler issues", description: "x" }]);
	});
	it("descarta entrada sem id/nome e id repetido; corpo errado dá null", () => {
		expect(parseMcpCatalog({ entries: [entry, entry, { name: "x" }, { id: "y" }, 3] })).toHaveLength(1);
		expect(parseMcpCatalog({})).toBeNull();
		expect(parseMcpCatalog(null)).toBeNull();
	});
	it("status desconhecido vira null; coming_soon e chave são lidos", () => {
		const [item] = parseMcpCatalog({ entries: [{ ...entry, status: "weird", availability: "coming_soon", authType: "api_key", oauthReady: "yes", apiKey: { label: "Chave", helpUrl: "https://x" }, accountCount: -3 }] })!;
		expect(item).toMatchObject({ status: null, comingSoon: true, authType: "api_key", oauthReady: false, accountCount: 0, apiKey: { label: "Chave", helpUrl: "https://x" } });
	});
});

describe("parseMcpConnections", () => {
	it("lê conexões válidas e ignora status inválido", () => {
		const list = parseMcpConnections({ connections: [{ id: "1", catalogId: null, slug: "meu", authType: "oauth", status: "pending_auth", accountLabel: "a@b" }, { id: "2", status: "zzz" }, { status: "connected" }] })!;
		expect(list).toEqual([{ id: "1", catalogId: null, name: "meu", authType: "oauth", status: "pending_auth", accountLabel: "a@b" }]);
		expect(parseMcpConnections({ connections: "x" })).toBeNull();
	});
});

describe("Composio", () => {
	it("página de apps: logo só https, descarta sem slug, total padrão", () => {
		const page = parseComposioPage({ items: [{ slug: "gmail", name: "Gmail", logo: "https://x/y.png", connected: true }, { slug: "a", name: "A", logo: "http://x" }, { name: "sem slug" }], nextCursor: "n" })!;
		expect(page.items.map((item) => [item.slug, item.logo, item.connected])).toEqual([["gmail", "https://x/y.png", true], ["a", null, false]]);
		expect(page).toMatchObject({ nextCursor: "n", totalItems: 2 });
		expect(parseComposioPage({ nextCursor: "n" })).toBeNull();
		expect(parseComposioPage({ items: [], nextCursor: "" })!.nextCursor).toBeNull();
	});
	it("status só é ativo com configured === true", () => {
		expect(parseComposioConfigured({ configured: true })).toBe(true);
		expect(parseComposioConfigured({ configured: "true" })).toBe(false);
		expect(parseComposioConfigured(null)).toBe(false);
	});
	it("categorias e conexões", () => {
		expect(parseComposioCategories({ categories: [{ id: "a", name: "A" }, { id: "", name: "x" }, 1] })).toEqual([{ id: "a", name: "A" }]);
		expect(parseComposioCategories({})).toEqual([]);
		expect(parseComposioConnections({ connections: [{ id: "1", toolkit: "gmail", toolkitName: "Gmail" }, { id: "2" }] })).toEqual([{ id: "1", toolkit: "gmail", toolkitName: "Gmail", noAuth: false }]);
	});
	it("safeLogoUrl recusa credenciais e esquemas que não são https", () => {
		expect(safeLogoUrl("https://u:p@x.com/a.png")).toBeNull();
		expect(safeLogoUrl("javascript:alert(1)")).toBeNull();
		expect(safeLogoUrl(undefined)).toBeNull();
	});
});

describe("endereço do navegador e resultado da conexão", () => {
	it("só https; http apenas com servidor http (desenvolvimento)", () => {
		expect(browserUrl("https://a.com/x")).toBe("https://a.com/x");
		expect(browserUrl("http://a.com/x")).toBeNull();
		expect(browserUrl("http://a.com/x", true)).toBe("http://a.com/x");
		expect(browserUrl("javascript:x", true)).toBeNull();
		expect(allowsHttp("http://192.168.0.2:3001")).toBe(true);
		expect(allowsHttp("https://api.exemplo.com")).toBe(false);
		expect(allowsHttp(null)).toBe(false);
		expect(pickBrowserUrl({ authorizeUrl: "http://l/a" }, true)).toBe("http://l/a");
		expect(parseConnectResult({ authorizeUrl: "http://l/a", connection: { id: "1" } })).toBeNull();
		expect(browserUrl("intent://x")).toBeNull();
		expect(browserUrl("")).toBeNull();
		expect(browserUrl(5)).toBeNull();
	});
	it("handoffUrl tem prioridade sobre authorizeUrl e redirectUrl", () => {
		expect(pickBrowserUrl({ handoffUrl: "https://h.com/", authorizeUrl: "https://a.com/", redirectUrl: "https://r.com/" })).toBe("https://h.com/");
		expect(pickBrowserUrl({ handoffUrl: "javascript:x", authorizeUrl: "https://a.com/" })).toBe("https://a.com/");
		expect(pickBrowserUrl({ redirectUrl: "https://r.com/" })).toBe("https://r.com/");
		expect(pickBrowserUrl({ authorizeUrl: null })).toBeNull();
	});
	it("resultado: navegador, conectado ou inválido", () => {
		expect(parseConnectResult({ connection: { id: "c9", status: "pending_auth" }, authorizeUrl: "https://a.com/" })).toEqual({ kind: "browser", url: "https://a.com/", connectionId: "c9" });
		expect(parseConnectResult({ connection: { id: "c9", status: "connected" }, authorizeUrl: null })).toEqual({ kind: "connected" });
		expect(parseConnectResult({ enabled: true, toolCount: 3 })).toEqual({ kind: "connected" });
		expect(parseConnectResult({ connection: { id: "c9", status: "pending_auth" }, authorizeUrl: null })).toBeNull();
		expect(parseConnectResult("x")).toBeNull();
	});
});
