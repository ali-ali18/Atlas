import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildSearchRequest,
	executeWebSearch,
	isWebSearchAvailable,
	normalizeSearchArgs,
	parseSearchResponse,
	resolveSearchApiKey,
	resolveSearchProvider,
	WEB_SEARCH_DEFAULT_LOCALE,
	WEB_SEARCH_DEFAULT_NUM,
	WebSearchError,
	type SearchFetchFn,
} from "./web-search.js";

afterEach(() => {
	vi.unstubAllEnvs();
});

function okJson(json: unknown, status = 200): Awaited<ReturnType<SearchFetchFn>> {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => json,
		text: async () => JSON.stringify(json),
	};
}

function httpError(status: number, body: string): Awaited<ReturnType<SearchFetchFn>> {
	return {
		ok: false,
		status,
		json: async () => ({}),
		text: async () => body,
	};
}

describe("resolveSearchProvider", () => {
	it("default é firecrawl e desconhecido cai para firecrawl", () => {
		expect(resolveSearchProvider(undefined)).toBe("firecrawl");
		expect(resolveSearchProvider("")).toBe("firecrawl");
		expect(resolveSearchProvider("google")).toBe("firecrawl");
	});

	it("aceita os 4 provedores (case-insensitive)", () => {
		expect(resolveSearchProvider("Tavily")).toBe("tavily");
		expect(resolveSearchProvider("brave")).toBe("brave");
		expect(resolveSearchProvider("serper")).toBe("serper");
		expect(resolveSearchProvider("firecrawl")).toBe("firecrawl");
	});
});

describe("resolveSearchApiKey / isWebSearchAvailable", () => {
	it("SEARCH_API_KEY tem precedência sobre FIRECRAWL_API_KEY", () => {
		vi.stubEnv("SEARCH_API_KEY", "search-key");
		vi.stubEnv("FIRECRAWL_API_KEY", "firecrawl-key");
		expect(resolveSearchApiKey()).toBe("search-key");
		expect(isWebSearchAvailable()).toBe(true);
	});

	it("cai para FIRECRAWL_API_KEY quando SEARCH_API_KEY ausente", () => {
		vi.stubEnv("SEARCH_API_KEY", "");
		vi.stubEnv("FIRECRAWL_API_KEY", "firecrawl-key");
		expect(resolveSearchApiKey()).toBe("firecrawl-key");
		expect(isWebSearchAvailable()).toBe(true);
	});

	it("sem chave => indisponível (integrador esconde a tool)", () => {
		vi.stubEnv("SEARCH_API_KEY", "");
		vi.stubEnv("FIRECRAWL_API_KEY", "");
		expect(resolveSearchApiKey()).toBeUndefined();
		expect(isWebSearchAvailable()).toBe(false);
	});
});

describe("normalizeSearchArgs", () => {
	it("defaults: num 8, locale pt-BR", () => {
		expect(normalizeSearchArgs({ query: "  café  " })).toEqual({
			query: "café",
			num: WEB_SEARCH_DEFAULT_NUM,
			locale: WEB_SEARCH_DEFAULT_LOCALE,
			recency: undefined,
		});
		expect(WEB_SEARCH_DEFAULT_NUM).toBe(8);
	});

	it("num é limitado a 1-10", () => {
		expect(normalizeSearchArgs({ query: "x", num: 99 }).num).toBe(10);
		expect(normalizeSearchArgs({ query: "x", num: 0 }).num).toBe(1);
		expect(normalizeSearchArgs({ query: "x", num: 5 }).num).toBe(5);
	});
});

describe("buildSearchRequest por provedor", () => {
	const args = { query: "preço macbook", num: 5 };

	it("firecrawl: POST /v1/search com Bearer", () => {
		const req = buildSearchRequest("firecrawl", args, "k1");
		expect(req.method).toBe("POST");
		expect(req.url).toBe("https://api.firecrawl.dev/v1/search");
		expect(req.headers.Authorization).toBe("Bearer k1");
		expect(JSON.parse(req.body ?? "{}")).toMatchObject({
			query: "preço macbook",
			limit: 5,
		});
	});

	it("tavily: api_key no corpo", () => {
		const req = buildSearchRequest("tavily", args, "k2");
		expect(req.url).toBe("https://api.tavily.com/search");
		expect(JSON.parse(req.body ?? "{}")).toMatchObject({
			api_key: "k2",
			query: "preço macbook",
			max_results: 5,
		});
	});

	it("brave: GET com X-Subscription-Token", () => {
		const req = buildSearchRequest("brave", args, "k3");
		expect(req.method).toBe("GET");
		expect(req.url).toContain("https://api.search.brave.com/res/v1/web/search?");
		expect(req.url).toContain("count=5");
		expect(req.headers["X-Subscription-Token"]).toBe("k3");
		expect(req.body).toBeUndefined();
	});

	it("serper: POST com X-API-KEY", () => {
		const req = buildSearchRequest("serper", args, "k4");
		expect(req.url).toBe("https://google.serper.dev/search");
		expect(req.headers["X-API-KEY"]).toBe("k4");
		expect(JSON.parse(req.body ?? "{}")).toMatchObject({
			q: "preço macbook",
			num: 5,
		});
	});
});

describe("parseSearchResponse por provedor", () => {
	it("firecrawl: data[]", () => {
		const results = parseSearchResponse("firecrawl", {
			data: [
				{ url: "https://a.com", title: "A", description: "desc a" },
				{ url: "", title: "sem url" },
			],
		});
		expect(results).toEqual([
			{ url: "https://a.com", title: "A", snippet: "desc a", source: "firecrawl" },
		]);
	});

	it("tavily: results[] com content", () => {
		const results = parseSearchResponse("tavily", {
			results: [{ url: "https://b.com", title: "B", content: "conteúdo b" }],
		});
		expect(results).toEqual([
			{ url: "https://b.com", title: "B", snippet: "conteúdo b", source: "tavily" },
		]);
	});

	it("brave: web.results[]", () => {
		const results = parseSearchResponse("brave", {
			web: { results: [{ url: "https://c.com", title: "C", description: "desc c" }] },
		});
		expect(results).toEqual([
			{ url: "https://c.com", title: "C", snippet: "desc c", source: "brave" },
		]);
	});

	it("serper: organic[] com link", () => {
		const results = parseSearchResponse("serper", {
			organic: [{ link: "https://d.com", title: "D", snippet: "snip d" }],
		});
		expect(results).toEqual([
			{ url: "https://d.com", title: "D", snippet: "snip d", source: "serper" },
		]);
	});

	it("formato desconhecido => lista vazia", () => {
		expect(parseSearchResponse("firecrawl", { nada: 1 })).toEqual([]);
		expect(parseSearchResponse("serper", null)).toEqual([]);
	});
});

describe("executeWebSearch", () => {
	it("sucesso via firecrawl com fetch injetado", async () => {
		const fetchFn: SearchFetchFn = vi.fn(async () =>
			okJson({ data: [{ url: "https://a.com", title: "A", description: "x" }] }),
		);
		const results = await executeWebSearch({ query: "teste" }, fetchFn, {
			provider: "firecrawl",
			apiKey: "k",
		});
		expect(results).toHaveLength(1);
		expect(fetchFn).toHaveBeenCalledTimes(1);
		const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [
			string,
			RequestInit,
		];
		expect(url).toContain("firecrawl");
		expect(init.method).toBe("POST");
	});

	it("query vazia => empty", async () => {
		const fetchFn: SearchFetchFn = vi.fn();
		await expect(
			executeWebSearch({ query: "   " }, fetchFn, { apiKey: "k" }),
		).rejects.toMatchObject({ code: "empty" });
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("sem chave => blocked com hint de ocultar a tool", async () => {
		const fetchFn: SearchFetchFn = vi.fn();
		const error = await executeWebSearch({ query: "x" }, fetchFn, {
			apiKey: undefined,
			env: { SEARCH_API_KEY: "", FIRECRAWL_API_KEY: "" },
		}).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(WebSearchError);
		expect(error).toMatchObject({ code: "blocked" });
		expect(String((error as WebSearchError).escalateHint)).toMatch(/oculta/);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("zero resultados => empty com hint de outra query", async () => {
		const fetchFn: SearchFetchFn = vi.fn(async () => okJson({ data: [] }));
		await expect(
			executeWebSearch({ query: "x" }, fetchFn, { apiKey: "k" }),
		).rejects.toMatchObject({
			code: "empty",
			escalateHint: expect.stringMatching(/outra query/),
		});
	});

	it("401 => needs_login", async () => {
		const fetchFn: SearchFetchFn = vi.fn(async () =>
			httpError(401, "unauthorized"),
		);
		await expect(
			executeWebSearch({ query: "x" }, fetchFn, { apiKey: "k" }),
		).rejects.toMatchObject({ code: "needs_login" });
	});

	it("429 => blocked", async () => {
		const fetchFn: SearchFetchFn = vi.fn(async () =>
			httpError(429, "rate limit"),
		);
		await expect(
			executeWebSearch({ query: "x" }, fetchFn, { apiKey: "k" }),
		).rejects.toMatchObject({ code: "blocked" });
	});

	it("timeout => code timeout", async () => {
		const fetchFn: SearchFetchFn = vi.fn(
			async (_url: string, init?: RequestInit) => {
				await new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () =>
						reject(new DOMException("aborted", "AbortError")),
					);
				});
				return okJson({ data: [] });
			},
		);
		await expect(
			executeWebSearch({ query: "x" }, fetchFn, { apiKey: "k", timeoutMs: 20 }),
		).rejects.toMatchObject({ code: "timeout" });
	});

	it("falha de rede => blocked com escalateHint", async () => {
		const fetchFn: SearchFetchFn = vi.fn(async () => {
			throw new Error("fetch failed");
		});
		await expect(
			executeWebSearch({ query: "x" }, fetchFn, { apiKey: "k" }),
		).rejects.toMatchObject({
			code: "blocked",
			escalateHint: expect.stringMatching(/navegador/),
		});
	});
});
