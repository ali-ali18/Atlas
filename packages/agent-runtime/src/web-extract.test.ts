import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildExtractRequest,
	buildScrapeRequest,
	executeWebExtract,
	isWebExtractAvailable,
	normalizeExtractMaxChars,
	parseExtractResponse,
	parseScrapeResponse,
	resolveFirecrawlApiKey,
	truncateExtractContent,
	WEB_EXTRACT_DEFAULT_MAX_CHARS,
	WEB_EXTRACT_MAX_URLS,
	WEB_EXTRACT_TOTAL_MAX_CHARS,
	WEB_EXTRACT_TRUNCATED_SUFFIX,
	WebExtractError,
	type ExtractFetchFn,
} from "./web-extract.js";

afterEach(() => {
	vi.unstubAllEnvs();
});

function okJson(json: unknown): Awaited<ReturnType<ExtractFetchFn>> {
	return {
		ok: true,
		status: 200,
		json: async () => json,
		text: async () => JSON.stringify(json),
	};
}

function httpError(status: number, body: string): Awaited<ReturnType<ExtractFetchFn>> {
	return {
		ok: false,
		status,
		json: async () => ({}),
		text: async () => body,
	};
}

describe("isWebExtractAvailable", () => {
	it("false sem FIRECRAWL_API_KEY", () => {
		vi.stubEnv("FIRECRAWL_API_KEY", "");
		expect(isWebExtractAvailable()).toBe(false);
		expect(resolveFirecrawlApiKey()).toBeUndefined();
	});

	it("true com FIRECRAWL_API_KEY", () => {
		vi.stubEnv("FIRECRAWL_API_KEY", "fc-key");
		expect(isWebExtractAvailable()).toBe(true);
	});
});

describe("builders", () => {
	it("scrape usa formats markdown", () => {
		const req = buildScrapeRequest("https://a.com", "k");
		expect(req.endpoint).toBe("scrape");
		expect(req.url).toContain("/v1/scrape");
		expect(req.headers.Authorization).toBe("Bearer k");
		expect(JSON.parse(req.body)).toMatchObject({
			url: "https://a.com",
			formats: ["markdown"],
		});
	});

	it("extract leva schema + prompt", () => {
		const schema = { type: "object", properties: { price: { type: "string" } } };
		const req = buildExtractRequest("https://a.com", "k", {
			schema,
			prompt: "extraia o preço",
		});
		expect(req.endpoint).toBe("extract");
		expect(req.url).toContain("/v1/extract");
		expect(JSON.parse(req.body)).toMatchObject({
			urls: ["https://a.com"],
			prompt: "extraia o preço",
			schema,
		});
	});
});

describe("parse + truncate", () => {
	it("parseScrapeResponse prefere markdown e lê title", () => {
		expect(
			parseScrapeResponse({
				success: true,
				data: { metadata: { title: "T" }, markdown: "# oi" },
			}),
		).toEqual({ title: "T", content: "# oi" });
		expect(parseScrapeResponse({ data: { markdown: "   " } })).toBeNull();
		expect(parseScrapeResponse(null)).toBeNull();
	});

	it("parseExtractResponse devolve data", () => {
		expect(
			parseExtractResponse({ success: true, data: { price: "R$ 10" } }),
		).toEqual({ data: { price: "R$ 10" } });
		expect(parseExtractResponse({ data: null })).toBeNull();
	});

	it("truncateExtractContent capa com sufixo", () => {
		const short = truncateExtractContent("abc", 8000);
		expect(short).toEqual({ content: "abc", truncated: false });
		const long = truncateExtractContent("x".repeat(9000), 8000);
		expect(long.truncated).toBe(true);
		expect(long.content).toHaveLength(8000 + WEB_EXTRACT_TRUNCATED_SUFFIX.length);
		expect(long.content.endsWith("[truncado...]")).toBe(true);
	});

	it("normalizeExtractMaxChars tem default 8000", () => {
		expect(normalizeExtractMaxChars(undefined)).toBe(WEB_EXTRACT_DEFAULT_MAX_CHARS);
		expect(WEB_EXTRACT_DEFAULT_MAX_CHARS).toBe(8000);
	});
});

describe("executeWebExtract", () => {
	it("lote de 3 URLs com 1 falha: erros por URL, ordem preservada", async () => {
		const fetchFn: ExtractFetchFn = vi.fn(async (url: string, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body ?? "{}")) as { url?: string };
			if (body.url === "https://bloqueado.com") {
				return httpError(403, "forbidden");
			}
			return okJson({
				data: { metadata: { title: `T ${body.url}` }, markdown: `md ${body.url}` },
			});
		});
		const items = await executeWebExtract(
			{
				urls: ["https://a.com", "https://bloqueado.com", "https://c.com"],
			},
			fetchFn,
			{ apiKey: "k" },
		);
		expect(items).toHaveLength(3);
		expect(items.map((item) => item.url)).toEqual([
			"https://a.com",
			"https://bloqueado.com",
			"https://c.com",
		]);
		expect(items[0]?.content).toContain("md https://a.com");
		expect(items[0]?.error).toBeUndefined();
		expect(items[1]?.error?.code).toBe("needs_login");
		expect(items[1]?.error?.escalateHint).toMatch(/navegador/);
		expect(items[2]?.content).toContain("md https://c.com");
		expect(fetchFn).toHaveBeenCalledTimes(3);
	});

	it("com schema usa /v1/extract e devolve data", async () => {
		const seen: string[] = [];
		const fetchFn: ExtractFetchFn = vi.fn(async (url: string) => {
			seen.push(url);
			return okJson({ success: true, data: { price: "R$ 10" } });
		});
		const schema = { type: "object", properties: { price: { type: "string" } } };
		const items = await executeWebExtract(
			{ urls: ["https://a.com"], schema, prompt: "preço" },
			fetchFn,
			{ apiKey: "k" },
		);
		expect(seen).toEqual(["https://api.firecrawl.dev/v1/extract"]);
		expect(items[0]?.data).toEqual({ price: "R$ 10" });
		expect(items[0]?.content).toBeUndefined();
		expect(items[0]?.error).toBeUndefined();
	});

	it("conteúdo longo é truncado com truncated=true", async () => {
		const fetchFn: ExtractFetchFn = vi.fn(async () =>
			okJson({ data: { metadata: {}, markdown: "y".repeat(10_000) } }),
		);
		const items = await executeWebExtract(
			{ urls: ["https://a.com"], maxChars: 8000 },
			fetchFn,
			{ apiKey: "k" },
		);
		expect(items[0]?.truncated).toBe(true);
		expect(items[0]?.content?.endsWith("[truncado...]")).toBe(true);
	});

	it("divide o teto total entre as URLs da chamada", async () => {
		const fetchFn: ExtractFetchFn = vi.fn(async () =>
			okJson({ data: { metadata: {}, markdown: "z".repeat(10_000) } }),
		);
		const urls = ["https://1.com", "https://2.com", "https://3.com", "https://4.com", "https://5.com"];
		const items = await executeWebExtract({ urls, maxChars: 8000 }, fetchFn, {
			apiKey: "k",
		});
		const perUrl = Math.floor(WEB_EXTRACT_TOTAL_MAX_CHARS / urls.length);
		for (const item of items) {
			expect(item.truncated).toBe(true);
			expect(item.content).toHaveLength(perUrl + WEB_EXTRACT_TRUNCATED_SUFFIX.length);
		}
	});

	it(`mais de ${WEB_EXTRACT_MAX_URLS} URLs => erro`, async () => {
		const fetchFn: ExtractFetchFn = vi.fn();
		await expect(
			executeWebExtract(
				{ urls: ["https://1.com", "https://2.com", "https://3.com", "https://4.com", "https://5.com", "https://6.com"] },
				fetchFn,
				{ apiKey: "k" },
			),
		).rejects.toBeInstanceOf(WebExtractError);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("sem chave => erro estruturado (tool fica oculta)", async () => {
		const fetchFn: ExtractFetchFn = vi.fn();
		await expect(
			executeWebExtract({ urls: ["https://a.com"] }, fetchFn, {
				apiKey: undefined,
				env: { FIRECRAWL_API_KEY: "" },
			}),
		).rejects.toMatchObject({ code: "blocked" });
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("extração vazia => error empty com hint de outra query", async () => {
		const fetchFn: ExtractFetchFn = vi.fn(async () =>
			okJson({ data: { markdown: "   " } }),
		);
		const items = await executeWebExtract({ urls: ["https://a.com"] }, fetchFn, {
			apiKey: "k",
		});
		expect(items[0]?.error?.code).toBe("empty");
		expect(items[0]?.error?.escalateHint).toMatch(/outra query/);
	});

	it("conteúdo apenas de menu/navegação => error empty", async () => {
		const fetchFn: ExtractFetchFn = vi.fn(async () =>
			okJson({
				data: {
					metadata: { title: "Menu" },
					markdown: "[Home](/) [About](/about) [Contact](/contact) Skip to content",
				},
			}),
		);
		const items = await executeWebExtract({ urls: ["https://a.com"] }, fetchFn, {
			apiKey: "k",
		});
		expect(items[0]?.error?.code).toBe("empty");
		expect(items[0]?.error?.message).toMatch(/navegação/);
	});

	it("conteúdo de artigo (>200 chars) com links => sucesso", async () => {
		const longArticle =
			"# Título do Artigo\n\nEste é um artigo com bastante conteúdo e informação relevante. " +
			"Lorem ipsum dolor sit amet, consectetur adipiscing elit. " +
			"Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. " +
			"Ut enim ad minim veniam, quis nostrud exercitation. " +
			"[Mais detalhes](https://exemplo.com) sobre o tema abordado aqui.";
		const fetchFn: ExtractFetchFn = vi.fn(async () =>
			okJson({
				data: {
					metadata: { title: "Artigo" },
					markdown: longArticle,
				},
			}),
		);
		const items = await executeWebExtract({ urls: ["https://a.com"] }, fetchFn, {
			apiKey: "k",
		});
		expect(items[0]?.error).toBeUndefined();
		expect(items[0]?.content).toContain("Artigo");
	});

	it("texto curto real com palavra de navegação (\"Back to school\") e poucos links não é só menu", async () => {
		const fetchFn: ExtractFetchFn = vi.fn(async () =>
			okJson({
				data: {
					metadata: { title: "Promo" },
					markdown: "Back to school: 20% off notebooks and backpacks this week, see [the offer](/offer) for details and conditions.",
				},
			}),
		);
		const items = await executeWebExtract({ urls: ["https://a.com"] }, fetchFn, { apiKey: "k" });
		expect(items[0]?.error).toBeUndefined();
		expect(items[0]?.content).toContain("Back to school");
	});
});
