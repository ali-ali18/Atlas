import { describe, expect, it, vi } from "vitest";
import { classifyBlockPage, detectBlockPage, isPageReadTool } from "./block-page.js";
import type { JevAsk } from "./decide.js";

const cloudflare = "Just a moment... Checking your browser before accessing the site.";
const consent = "We use cookies to improve your experience. Please accept all cookies to continue browsing this site and enable JavaScript.";
const article = "Lorem ipsum dolor sit amet. ".repeat(200);

const rt = (mode: "off" | "shadow" | "on", ask: JevAsk) => ({ ask, modes: { blockpage: mode } });
const yes: JevAsk = vi.fn(async () => ({ model: "m", answers: { block_page: 0.95 }, durationMs: 1 }));
const no: JevAsk = vi.fn(async () => ({ model: "m", answers: { block_page: 0.05 }, durationMs: 1 }));

describe("página de bloqueio (F11)", () => {
	it("heurística: bloqueio claro, conteúdo longo e dúvida", () => {
		expect(classifyBlockPage(cloudflare)).toBe("blocked");
		expect(classifyBlockPage(article)).toBe("clean");
		expect(classifyBlockPage(consent)).toBe("ambiguous");
		expect(classifyBlockPage("ok")).toBe("ambiguous");
	});

	it("só lê tools de página", () => {
		expect(isPageReadTool("web_extract")).toBe(true);
		expect(isPageReadTool("browser_text")).toBe(true);
		expect(isPageReadTool("mcp__firecrawl__firecrawl_scrape")).toBe(true);
		expect(isPageReadTool("mcp__firecrawl__firecrawl_search")).toBe(false);
	});

	it("bloqueio claro em on: dica de proxy mais forte sem gastar chamada", async () => {
		const ask = vi.fn(yes);
		const hint = await detectBlockPage({ rt: rt("on", ask), toolName: "mcp__firecrawl__firecrawl_scrape", resultText: cloudflare });
		expect(hint).toContain("stronger proxy option");
		expect(ask).not.toHaveBeenCalled();
	});

	it("ambíguo: pergunta ao Jev; sim dá dica, não dá nada", async () => {
		expect(await detectBlockPage({ rt: rt("on", yes), toolName: "web_extract", resultText: consent })).toContain("another source");
		expect(await detectBlockPage({ rt: rt("on", no), toolName: "web_extract", resultText: consent })).toBeNull();
	});

	it("conteúdo limpo não chama o Jev; off e shadow não mudam o resultado; falha = sem dica", async () => {
		const ask = vi.fn(yes);
		expect(await detectBlockPage({ rt: rt("on", ask), toolName: "web_extract", resultText: article })).toBeNull();
		expect(ask).not.toHaveBeenCalled();
		expect(await detectBlockPage({ rt: rt("off", ask), toolName: "web_extract", resultText: cloudflare })).toBeNull();
		expect(await detectBlockPage({ rt: rt("shadow", ask), toolName: "web_extract", resultText: cloudflare })).toBeNull();
		expect(await detectBlockPage({ rt: rt("shadow", ask), toolName: "web_extract", resultText: consent })).toBeNull();
		const broken: JevAsk = async () => {
			throw new Error("down");
		};
		expect(await detectBlockPage({ rt: rt("on", broken), toolName: "web_extract", resultText: consent })).toBeNull();
	});
});
