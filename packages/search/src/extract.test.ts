import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  NEEDS_JS_MESSAGE,
  clearExtractCache,
  clearExtractRateLimits,
  clearExtractRobotsCache,
  extractWebPage,
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
