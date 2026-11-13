import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  NEEDS_JS_MESSAGE,
  clearExtractCache,
  clearExtractRateLimits,
  clearExtractRobotsCache,
  extractWebPage,
  decodeHtmlBytes,
  fetchPageHtml,
  htmlToMarkdown,
  type ExtractFetchFn,
  type ExtractLookupFn,
} from "./extract.js";

const publicLookup: ExtractLookupFn = async () => ["93.184.216.34"];

function html(body: string, title = "Página"): string {
  return `<html><head><title>${title}</title></head><body>${body}</body></html>`;
}

const LONG = "Texto do artigo com conteúdo suficiente para passar do mínimo. ".repeat(10);

function response(
  body: string,
  init: ResponseInit & { headers?: Record<string, string> } = {},
): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    ...init,
  });
}

beforeEach(() => {
  clearExtractCache();
  clearExtractRateLimits();
  clearExtractRobotsCache();
});

describe("htmlToMarkdown", () => {
  it("extrai o conteúdo principal em Markdown com título", () => {
    const { title, markdown } = htmlToMarkdown(
      html(`<nav>menu</nav><article><h1>Preço</h1><p>MacBook por R$ 7.999</p><p>${LONG}</p></article>`),
      "https://exemplo.com/produto",
    );
    expect(title).toBe("Página");
    expect(markdown).toContain("MacBook por R$ 7.999");
    expect(markdown).not.toContain("menu");
  });
});

describe("extractWebPage", () => {
  it("extrai HTML em Markdown com título", async () => {
    const fetchFn: ExtractFetchFn = vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      return response(html(`<main><h1>Artigo</h1><p>${LONG}</p></main>`, "Artigo"));
    });
    const page = await extractWebPage("https://a.com/ok", { fetchFn, lookupFn: publicLookup });
    expect(page.title).toBe("Artigo");
    expect(page.markdown).toContain("Texto do artigo");
    expect(page.truncated).toBe(false);
  });

  it("401/403 vira needs_login", async () => {
    const fetchFn: ExtractFetchFn = async (url: string) =>
      url.endsWith("/robots.txt") ? new Response("", { status: 404 }) : response("negado", { status: 403 });
    await expect(
      extractWebPage("https://a.com/login", { fetchFn, lookupFn: publicLookup }),
    ).rejects.toMatchObject({ code: "needs_login" });
  });

  it("página SPA sem conteúdo vira needs_js com mensagem clara", async () => {
    const fetchFn: ExtractFetchFn = async (url: string) =>
      url.endsWith("/robots.txt")
        ? new Response("", { status: 404 })
        : response(html(`<div id="root"></div><script>app()</script>`));
    const error = await extractWebPage("https://a.com/spa", {
      fetchFn,
      lookupFn: publicLookup,
    }).catch((e) => e);
    expect(error.code).toBe("needs_js");
    expect(String(error.message)).toContain(NEEDS_JS_MESSAGE);
  });

  it("respeita robots.txt (Disallow)", async () => {
    const fetchFn: ExtractFetchFn = async (url: string) => {
      if (url.endsWith("/robots.txt")) {
        return new Response("User-agent: *\nDisallow: /privado", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }
      return response(html(`<main><p>${LONG}</p></main>`));
    };
    await expect(
      extractWebPage("https://a.com/privado/x", { fetchFn, lookupFn: publicLookup }),
    ).rejects.toMatchObject({ code: "robots_denied" });
    // Fora do Disallow passa.
    const page = await extractWebPage("https://a.com/publico", { fetchFn, lookupFn: publicLookup });
    expect(page.markdown).toContain("Texto do artigo");
  });

  it("rate-limit por domínio em memória", async () => {
    const fetchFn: ExtractFetchFn = async (url: string) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      return response(html(`<main><p>${LONG}</p></main>`));
    };
    // 8 por janela: as 8 primeiras passam (cache só vale 5 min por URL
    // distinta — usa URLs distintas para forçar fetch real).
    for (let i = 0; i < 8; i += 1) {
      await extractWebPage(`https://a.com/p${i}`, { fetchFn, lookupFn: publicLookup });
    }
    await expect(
      extractWebPage("https://a.com/p8", { fetchFn, lookupFn: publicLookup }),
    ).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("cache condicional: TTL curto-circuita e 304 reaproveita o Markdown", async () => {
    const sentHeaders: Array<Record<string, string>> = [];
    const fetchFn: ExtractFetchFn = async (url: string, init?: RequestInit) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      sentHeaders.push({ ...(init?.headers as Record<string, string>) });
      if (sentHeaders.length === 1) {
        return response(html(`<main><p>${LONG}</p></main>`, "Artigo"), {
          headers: { etag: '"v1"', "content-type": "text/html" },
        });
      }
      return new Response(null, { status: 304 });
    };
    const first = await extractWebPage("https://a.com/c", { fetchFn, lookupFn: publicLookup });
    expect(first.fromCache).toBeUndefined();

    // Dentro do TTL: nem refaz o fetch da página.
    clearExtractRateLimits();
    const second = await extractWebPage("https://a.com/c", { fetchFn, lookupFn: publicLookup });
    expect(second.fromCache).toBe(true);
    expect(second.markdown).toBe(first.markdown);
    expect(sentHeaders).toHaveLength(1);

    // TTL expirado: revalida com If-None-Match e 304 reaproveita.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 6 * 60_000);
      clearExtractRateLimits();
      const third = await extractWebPage("https://a.com/c", { fetchFn, lookupFn: publicLookup });
      expect(third.fromCache).toBe(true);
      expect(third.markdown).toBe(first.markdown);
      expect(sentHeaders).toHaveLength(2);
      expect(sentHeaders[1]?.["If-None-Match"]).toBe('"v1"');
    } finally {
      vi.useRealTimers();
    }
  });

  it("bloqueia redirect para rede interna (SSRF)", async () => {
    const fetchFn: ExtractFetchFn = vi.fn(async (url: string) =>
      url.startsWith("https://publico.com/robots.txt")
        ? new Response("", { status: 404 })
        : url.startsWith("https://publico.com")
          ? response("", { status: 302, headers: { location: "http://127.0.0.1:6379/" } })
          : response(html(LONG)),
    );
    await expect(
      extractWebPage("https://publico.com/r", { fetchFn, lookupFn: publicLookup }),
    ).rejects.toMatchObject({ code: "blocked" });
    expect(fetchFn).toHaveBeenCalledTimes(2); // robots + 1 fetch (redirect barrado)
  });

  it("PDF inválido vira blocked (sem crash)", async () => {
    const fetchFn: ExtractFetchFn = async (url: string) =>
      url.endsWith("/robots.txt")
        ? new Response("", { status: 404 })
        : response("%PDF", { headers: { "content-type": "application/pdf" } });
    await expect(
      extractWebPage("https://a.com/doc.pdf", { fetchFn, lookupFn: publicLookup }),
    ).rejects.toMatchObject({ code: "blocked" });
  });
});

describe("fetchPageHtml (F6.1)", () => {
  const ld = '<script type="application/ld+json">{"@type":"Product","name":"Fone"}</script>';

  it("devolve a marcação bruta, com o JSON-LD que o Markdown perde", async () => {
    const fetchFn: ExtractFetchFn = async (url: string) =>
      url.endsWith("/robots.txt") ? new Response("", { status: 404 }) : response(`<html><head>${ld}</head><body>x</body></html>`);
    const page = await fetchPageHtml("https://a.com/p/fone", { fetchFn, lookupFn: publicLookup });
    expect(page.url).toBe("https://a.com/p/fone");
    expect(page.html).toContain('"@type":"Product"');
  });

  it("decodifica pelo charset do Content-Type ou do <meta>, com UTF-8 de padrão e fallback seguro", async () => {
    // "Fone sem fio – promoção" em Latin-1: ç = 0xE7, ã = 0xE3, en dash não existe (usa hífen)
    const latin1 = (s: string) => Uint8Array.from(Array.from(s).map((c) => c.charCodeAt(0)));
    expect(decodeHtmlBytes(latin1("<html>promoção</html>"), "text/html; charset=ISO-8859-1")).toContain("promoção");
    expect(decodeHtmlBytes(latin1('<html><head><meta charset="windows-1252"></head>promoção</html>'), "text/html")).toContain("promoção");
    expect(decodeHtmlBytes(latin1('<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1">ação'), "")).toContain("ação");
    const utf8 = new TextEncoder().encode("<html>promoção</html>");
    expect(decodeHtmlBytes(utf8, "text/html")).toContain("promoção");
    // rótulo inventado: cai em UTF-8, sem lançar
    expect(decodeHtmlBytes(utf8, "text/html; charset=x-inventado")).toContain("promoção");
  });

  it("fetchPageHtml entrega o texto certo de uma página Latin-1", async () => {
    const body = Uint8Array.from(Array.from(`<html><head>${ld}</head><body>Promoção</body></html>`).map((c) => c.charCodeAt(0)));
    const fetchFn: ExtractFetchFn = async (url: string) =>
      url.endsWith("/robots.txt") ? new Response("", { status: 404 }) : new Response(body, { status: 200, headers: { "content-type": "text/html; charset=iso-8859-1" } });
    const page = await fetchPageHtml("https://a.com/p/latin", { fetchFn, lookupFn: publicLookup });
    expect(page.html).toContain("Promoção");
  });

  it("barra SSRF: IP interno, DNS que resolve para privado e redirecionamento para metadata", async () => {
    const never: ExtractFetchFn = vi.fn(async () => response("x"));
    await expect(fetchPageHtml("http://169.254.169.254/latest", { fetchFn: never, lookupFn: publicLookup })).rejects.toMatchObject({ code: "blocked" });
    await expect(fetchPageHtml("https://interno.a.com/x", { fetchFn: never, lookupFn: async () => ["10.0.0.5"] })).rejects.toMatchObject({ code: "blocked" });
    const redirect: ExtractFetchFn = async (url: string) =>
      url.endsWith("/robots.txt") ? new Response("", { status: 404 }) : new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } });
    await expect(fetchPageHtml("https://a.com/r", { fetchFn: redirect, lookupFn: publicLookup })).rejects.toMatchObject({ code: "blocked" });
    expect(never).not.toHaveBeenCalled();
  });

  it("respeita robots.txt, recusa conteúdo que não é página e erro HTTP", async () => {
    const robots: ExtractFetchFn = async (url: string) => (url.endsWith("/robots.txt") ? new Response("User-agent: *\nDisallow: /p", { status: 200 }) : response("x"));
    await expect(fetchPageHtml("https://a.com/p/x", { fetchFn: robots, lookupFn: publicLookup })).rejects.toMatchObject({ code: "robots_denied" });
    const pdf: ExtractFetchFn = async (url: string) => (url.endsWith("/robots.txt") ? new Response("", { status: 404 }) : response("%PDF", { headers: { "content-type": "application/pdf" } }));
    await expect(fetchPageHtml("https://b.com/x", { fetchFn: pdf, lookupFn: publicLookup })).rejects.toMatchObject({ code: "blocked" });
    const gone: ExtractFetchFn = async (url: string) => (url.endsWith("/robots.txt") ? new Response("", { status: 404 }) : response("", { status: 404 }));
    await expect(fetchPageHtml("https://c.com/x", { fetchFn: gone, lookupFn: publicLookup })).rejects.toMatchObject({ code: "blocked" });
  });
});
