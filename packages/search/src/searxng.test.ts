import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  canonicalizeUrl,
  clearSearxngCircuitBreakers,
  dedupeSearxngResults,
  getDisabledSearxngEngines,
  isSearchAvailable,
  isSearxngCircuitOpen,
  parseSearxngResponse,
  recordSearxngFailure,
  searchSearxng,
  searxngBreakerKey,
  type SearxngFetchFn,
} from "./searxng.js";

beforeEach(() => {
  clearSearxngCircuitBreakers();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const SEARXNG_FIXTURE = {
  results: [
    {
      url: "https://exemplo.com/mac?utm_source=google",
      title: "Mac na Loja",
      content: "Preço bom",
      engine: "duckduckgo",
    },
    {
      url: "https://exemplo.com/mac#oferta",
      title: "Mac na Loja (dup)",
      content: "Preço bom",
      engine: "bing",
    },
    {
      url: "https://outra.com/mac",
      title: "Outro",
      content: "Outro preço",
      engine: "mojeek",
    },
  ],
};

describe("canonicalizeUrl / dedupe", () => {
  it("normaliza host, tracking, hash e barra final", () => {
    expect(canonicalizeUrl("https://EXEMPLO.com/mac/?utm_source=x#top")).toBe(
      "https://exemplo.com/mac",
    );
    expect(canonicalizeUrl("https://exemplo.com/?fbclid=abc")).toBe(
      "https://exemplo.com",
    );
  });

  it("dedupe preserva a primeira ocorrência", () => {
    const out = dedupeSearxngResults([
      { url: "https://a.com/x?utm_campaign=1" },
      { url: "https://a.com/x" },
      { url: "https://b.com/y" },
    ]);
    expect(out.map((item) => item.url)).toEqual([
      "https://a.com/x?utm_campaign=1",
      "https://b.com/y",
    ]);
  });
});

describe("isSearchAvailable", () => {
  it("false sem SEARXNG_BASE_URL, true com", () => {
    expect(isSearchAvailable({})).toBe(false);
    expect(isSearchAvailable({ SEARXNG_BASE_URL: "http://searxng:8080" })).toBe(true);
  });
});

describe("parseSearxngResponse", () => {
  it("mapeia resultados e remove duplicadas", () => {
    const out = parseSearxngResponse(SEARXNG_FIXTURE);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      url: "https://exemplo.com/mac?utm_source=google",
      title: "Mac na Loja",
      snippet: "Preço bom",
      engine: "duckduckgo",
    });
  });

  it("ignora URLs não-http e corpo desconhecido", () => {
    expect(parseSearxngResponse({ results: [{ url: "ftp://x/y" }] })).toEqual([]);
    expect(parseSearxngResponse(null)).toEqual([]);
  });
});

describe("searchSearxng", () => {
  it("busca, faz parse e limita a num", async () => {
    const seen: string[] = [];
    const fetchFn: SearxngFetchFn = vi.fn(async (url: string) => {
      seen.push(url);
      return jsonResponse(SEARXNG_FIXTURE);
    });
    const results = await searchSearxng("macbook", {
      baseUrl: "http://searxng:8080",
      num: 2,
      fetchFn,
    });
    expect(results).toHaveLength(2);
    expect(seen[0]).toContain("format=json");
    expect(seen[0]).toContain("timeout_limit=");
  });

  it("retry com backoff após falha transitória", async () => {
    // Primeira chamada 500, segunda OK.
    let calls = 0;
    const flaky: SearxngFetchFn = async () => {
      calls += 1;
      return calls === 1 ? jsonResponse({}, 500) : jsonResponse(SEARXNG_FIXTURE);
    };
    const results = await searchSearxng("macbook", {
      baseUrl: "http://searxng:8080",
      fetchFn: flaky,
      num: 1,
    });
    expect(results).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it("abre o circuito após falhas e exclui a engine da rotação", async () => {
    const key = searxngBreakerKey("engine", "bing");
    recordSearxngFailure(key);
    recordSearxngFailure(key);
    expect(isSearxngCircuitOpen(key)).toBe(false);
    recordSearxngFailure(key);
    expect(isSearxngCircuitOpen(key)).toBe(true);
    expect(getDisabledSearxngEngines()).toContain("bing");

    const seen: string[] = [];
    const ok: SearxngFetchFn = async (url: string) => {
      seen.push(url);
      return jsonResponse(SEARXNG_FIXTURE);
    };
    await searchSearxng("x", {
      baseUrl: "http://s:8080",
      engines: ["bing", "mojeek"],
      fetchFn: ok,
    });
    // bing fora da rotação: só mojeek no parâmetro engines.
    expect(seen[0]).toContain("engines=mojeek");
    expect(seen[0]).not.toContain("bing");
  });

  it("query vazia e base ausente viram erro estruturado", async () => {
    await expect(searchSearxng("  ", { baseUrl: "http://s:8080" })).rejects.toMatchObject({
      code: "empty",
    });
    await expect(searchSearxng("x", { env: {} })).rejects.toMatchObject({ code: "blocked" });
  });

  it("sem resultados vira empty (sem retry inútil)", async () => {
    const fetchFn: SearxngFetchFn = vi.fn(async () => jsonResponse({ results: [] }));
    await expect(
      searchSearxng("x", { baseUrl: "http://s:8080", fetchFn }),
    ).rejects.toMatchObject({ code: "empty" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
