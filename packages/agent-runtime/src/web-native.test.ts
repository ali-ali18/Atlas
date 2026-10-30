import { describe, expect, it, vi } from "vitest";
import {
	assertPublicUrl,
	decodeEntities,
	htmlToText,
	isPrivateAddress,
	nativeWebExtract,
	nativeWebSearch,
	parseDuckDuckGoHtml,
	type NativeFetchFn,
	type NativeLookupFn,
} from "./web-native.js";
import { WebSearchError } from "./web-search.js";

const publicLookup: NativeLookupFn = async () => ["93.184.216.34"];

function html(body: string, title = "Página"): string {
	return `<html><head><title>${title}</title><script>alert(1)</script></head><body>${body}</body></html>`;
}

const LONG = "Texto do artigo com conteúdo suficiente para passar do mínimo. ".repeat(10);

describe("SSRF guard", () => {
	it("classifica endereços privados e públicos", () => {
		for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.0.10", "169.254.169.254", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
			expect(isPrivateAddress(ip), ip).toBe(true);
		}
		for (const ip of ["93.184.216.34", "8.8.8.8", "2606:4700::1111"]) {
			expect(isPrivateAddress(ip), ip).toBe(false);
		}
	});

	it("bloqueia IPv4 interno embutido em IPv6, em hexadecimal e pontuado (mesmo guard do leitor de alertas)", async () => {
		for (const ip of ["::ffff:7f00:1", "::ffff:a9fe:a9fe", "::127.0.0.1", "64:ff9b::7f00:1", "2002:a9fe:a9fe::1"]) {
			expect(isPrivateAddress(ip), ip).toBe(true);
		}
		await expect(assertPublicUrl("http://[::ffff:127.0.0.1]/", publicLookup)).rejects.toMatchObject({ code: "blocked" });
		await expect(assertPublicUrl("http://[::ffff:169.254.169.254]/", publicLookup)).rejects.toMatchObject({ code: "blocked" });
	});

	it("recusa localhost, IP privado, DNS privado e protocolo não-http", async () => {
		await expect(assertPublicUrl("http://localhost:3001/v1/settings", publicLookup)).rejects.toMatchObject({ code: "blocked" });
		await expect(assertPublicUrl("http://169.254.169.254/latest", publicLookup)).rejects.toMatchObject({ code: "blocked" });
		await expect(assertPublicUrl("file:///etc/passwd", publicLookup)).rejects.toMatchObject({ code: "blocked" });
		await expect(assertPublicUrl("https://interno.exemplo", async () => ["10.0.0.5"])).rejects.toMatchObject({ code: "blocked" });
		await expect(assertPublicUrl("https://exemplo.com/a", publicLookup)).resolves.toBeInstanceOf(URL);
	});
});

describe("htmlToText", () => {
	it("tira script/nav, mantém títulos, listas e links absolutos", () => {
		const { title, text } = htmlToText(
			html(`<nav>menu</nav><h1>Preço &amp; estoque</h1><p>MacBook por <b>R$&nbsp;7.999</b></p><ul><li>Um</li><li>Dois</li></ul><a href="/loja">Loja</a>`, "Título &#8211; Site"),
			"https://exemplo.com/produto",
		);
		expect(title).toBe("Título – Site");
		expect(text).not.toContain("alert");
		expect(text).not.toContain("menu");
		expect(text).toContain("# Preço & estoque");
		expect(text).toContain("MacBook por R$ 7.999");
		expect(text).toContain("- Um\n- Dois");
		expect(text).toContain("[Loja](https://exemplo.com/loja)");
	});

	it("colapsa listas longas de links (menus, idiomas)", () => {
		const langs = Array.from({ length: 12 }, (_, i) => `<li><a href="https://x${i}.org/">L${i}</a></li>`).join("");
		const { text } = htmlToText(html(`<ul>${langs}</ul><p>Conteúdo real</p><ul><li><a href="/a">A</a></li></ul>`), "https://exemplo.com");
		expect(text).toContain("[12 links omitidos]");
		expect(text).not.toContain("x3.org");
		expect(text).toContain("Conteúdo real");
		expect(text).toContain("[A](https://exemplo.com/a)");
	});

	it("prefere <article> quando tem texto suficiente", () => {
		const { text } = htmlToText(html(`<div>barra lateral</div><article>${LONG}</article>`));
		expect(text).not.toContain("barra lateral");
		expect(decodeEntities("&#x41;&#66;&lt;")).toBe("AB<");
	});
});

function response(body: string, init: ResponseInit & { headers?: Record<string, string> } = {}): Response {
	return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, ...init });
}

describe("nativeWebExtract", () => {
	it("extrai em lote, preserva ordem e classifica erros por URL", async () => {
		const fetchFn: NativeFetchFn = vi.fn(async (url: string) => {
			if (url.includes("login")) return response("negado", { status: 403 });
			if (url.includes("spa")) return response(html(`<div id="root"></div>`));
			if (url.includes("pdf")) return response("%PDF", { headers: { "content-type": "application/pdf" } });
			return response(html(`<main>${LONG}</main>`, "Artigo"));
		});
		const items = await nativeWebExtract(
			{ urls: ["https://a.com/ok", "https://a.com/login", "https://a.com/spa", "https://a.com/doc.pdf"] },
			{ fetchFn, lookupFn: publicLookup },
		);
		expect(items.map((item) => item.url)).toEqual(["https://a.com/ok", "https://a.com/login", "https://a.com/spa", "https://a.com/doc.pdf"]);
		expect(items[0]?.title).toBe("Artigo");
		expect(items[0]?.content).toContain("Texto do artigo");
		expect(items[1]?.error?.code).toBe("needs_login");
		expect(items[2]?.error?.code).toBe("empty");
		expect(items[2]?.error?.escalateHint).toMatch(/navegador/);
		expect(items[3]?.error?.code).toBe("blocked");
	});

	it("timeout: página que não responde vira erro por URL com dica, sem travar o lote", async () => {
		const fetchFn: NativeFetchFn = vi.fn(
			(url: string, init?: RequestInit) =>
				url.endsWith("/robots.txt")
					? Promise.resolve(response("", { status: 404 }))
					: new Promise<Response>((_resolve, reject) => {
							init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
						}),
		);
		const [item] = await nativeWebExtract({ urls: ["https://lenta.com/p"] }, { fetchFn, lookupFn: publicLookup, timeoutMs: 30 });
		expect(item?.error?.code).toBe("timeout");
		expect(item?.error?.escalateHint).toMatch(/navegador/);
	});

	it("limite de tamanho: corpo gigante é cortado e a extração não estoura", async () => {
		const huge = html(`<main>${"parágrafo longo de teste. ".repeat(200_000)}</main>`);
		expect(huge.length).toBeGreaterThan(2_000_000);
		const fetchFn: NativeFetchFn = vi.fn(async (url: string) =>
			url.endsWith("/robots.txt") ? response("", { status: 404 }) : response(huge),
		);
		const [item] = await nativeWebExtract({ urls: ["https://grande.com/p"], maxChars: 5000 }, { fetchFn, lookupFn: publicLookup });
		expect(item?.error).toBeUndefined();
		expect(item?.truncated).toBe(true);
		expect((item?.content ?? "").length).toBeLessThanOrEqual(5000 + 20);
	});

	it("bloqueia redirect para rede interna", async () => {
		const fetchFn: NativeFetchFn = vi.fn(async (url: string) =>
			url.startsWith("https://publico.com")
				? url.endsWith("/robots.txt")
					? response("", { status: 404 })
					: response("", { status: 302, headers: { location: "http://127.0.0.1:6379/" } })
				: response(html(LONG)),
		);
		const [item] = await nativeWebExtract({ urls: ["https://publico.com/r"] }, { fetchFn, lookupFn: publicLookup });
		expect(item?.error?.code).toBe("blocked");
		// S2: robots.txt + 1 fetch (o redirect interno é barrado antes do 2º).
		expect(fetchFn).toHaveBeenCalledTimes(2);
	});
});

const DDG_FIXTURE = `
<div class="result results_links results_links_deep result--ad ">
  <a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad=1">Anúncio</a>
</div>
<div class="result results_links results_links_deep web-result ">
  <div class="links_main links_deep result__body">
    <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.apple.com%2Fbr%2Fmacbook-air%2F&amp;rut=abc">MacBook Air - <b>Apple</b> (BR)</a></h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">O MacBook Air com chip <b>M3</b>&#x27;s.</a>
  </div>
</div>
<div class="result results_links results_links_deep web-result ">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexemplo.com%2Fb">Loja B</a></h2>
</div>
<div class="result results_links results_links_deep web-result ">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fduckduckgo.com%2Fy.js%3Fad_domain%3Dloja.com">Anúncio embrulhado</a></h2>
</div>`;

describe("nativeWebSearch", () => {
	it("parseia resultados, desembrulha uddg e pula anúncios", () => {
		expect(parseDuckDuckGoHtml(DDG_FIXTURE)).toEqual([
			{ url: "https://www.apple.com/br/macbook-air/", title: "MacBook Air - Apple (BR)", snippet: "O MacBook Air com chip M3's.", source: "duckduckgo" },
			{ url: "https://exemplo.com/b", title: "Loja B", snippet: "", source: "duckduckgo" },
		]);
		expect(parseDuckDuckGoHtml(DDG_FIXTURE, 1)).toHaveLength(1);
	});

	it("monta a query com região/recência e trata bloqueio", async () => {
		const seen: string[] = [];
		const ok: NativeFetchFn = vi.fn(async (url: string) => {
			seen.push(url);
			return response(DDG_FIXTURE);
		});
		const results = await nativeWebSearch({ query: "macbook air m3", recency: "week" }, { fetchFn: ok });
		expect(results).toHaveLength(2);
		expect(seen[0]).toContain("kl=br-pt");
		expect(seen[0]).toContain("df=w");

		const blocked: NativeFetchFn = vi.fn(async () => response("", { status: 202 }));
		await expect(nativeWebSearch({ query: "x" }, { fetchFn: blocked })).rejects.toBeInstanceOf(WebSearchError);
		const empty: NativeFetchFn = vi.fn(async () => response("<html></html>"));
		await expect(nativeWebSearch({ query: "x" }, { fetchFn: empty })).rejects.toMatchObject({ code: "empty" });
	});
});
