import { describe, expect, it, vi } from "vitest";
import { createWebCapability } from "../presets/web.js";
import { DEFAULT_PAGE_CHARS } from "../kernel/work-notes.js";
import { call, kernelHarness, reply } from "../testing/kernel-fakes.js";
import { acceptLanguageFor, createWebAdapter, EXTRACT_TECHNICAL_MAX_CHARS, type ExtractPageFn, type FetchLike, type SearxngSearchFn } from "./web.js";

const DDG = `<div class="result web-result"><h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexemplo.com%2Fa">Exemplo A</a></h2><a class="result__snippet" href="x">Trecho A</a></div>`;
const html = (body: string, status = 200) => new Response(body, { status });
const neverExtract: ExtractPageFn = async () => {
	throw new Error("não devia extrair");
};

describe("adaptador web: busca", () => {
	it("usa o SearXNG quando há resultado e não chama o DuckDuckGo", async () => {
		const fetchFn = vi.fn<FetchLike>();
		const searxng: SearxngSearchFn = async () => [{ url: "https://a.test/1", title: "A", snippet: "s" }];
		const web = createWebAdapter({ extract: neverExtract, searxng, fetchFn });
		expect(await web.search("owner-1", "x", { limit: 3 })).toEqual([{ url: "https://a.test/1", title: "A", snippet: "s" }]);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("SearXNG que falha ou volta vazio cai para o DuckDuckGo", async () => {
		const fetchFn = vi.fn<FetchLike>(async () => html(DDG));
		for (const searxng of [async () => Promise.reject(new Error("fora")), async () => []] as SearxngSearchFn[]) {
			const web = createWebAdapter({ extract: neverExtract, searxng, fetchFn });
			expect(await web.search("owner-1", "x")).toEqual([{ url: "https://exemplo.com/a", title: "Exemplo A", snippet: "Trecho A" }]);
		}
		expect(fetchFn.mock.calls[0]?.[0]).toContain("kl=br-pt");
	});

	it("sem SearXNG vai direto ao DuckDuckGo; bloqueio e captcha viram erro honesto em inglês", async () => {
		for (const response of [html("", 202), html("<div id='anomaly-modal'></div>"), html("", 500)]) {
			const web = createWebAdapter({ extract: neverExtract, fetchFn: async () => response });
			await expect(web.search("owner-1", "x")).rejects.toThrow(/Web search is unavailable right now\./);
		}
	});

	it("respeita o limite pedido e o cancelamento do run", async () => {
		const many = Array.from({ length: 5 }, (_, i) => ({ url: `https://a.test/${i}`, title: `T${i}`, snippet: "" }));
		const web = createWebAdapter({ extract: neverExtract, searxng: async () => many });
		expect(await web.search("owner-1", "x", { limit: 2 })).toHaveLength(2);
		const controller = new AbortController();
		controller.abort(new Error("parado"));
		const aborting = createWebAdapter({ extract: neverExtract, searxng: async () => Promise.reject(new Error("abortado")), fetchFn: async () => html(DDG) });
		await expect(aborting.search("owner-1", "x", undefined, controller.signal)).rejects.toThrow("abortado");
	});
});

describe("adaptador web: Accept-Language (auditoria F2, R5)", () => {
	const headerFor = async (locale?: string) => {
		const fetchFn = vi.fn<FetchLike>(async () => html(DDG));
		await createWebAdapter({ extract: neverExtract, fetchFn, ...(locale && { locale }) }).search("owner-1", "x");
		return (fetchFn.mock.calls[0]?.[1]?.headers as Record<string, string>)["Accept-Language"];
	};

	it("deriva do idioma do run; sem idioma ou com formato inválido cai em en", async () => {
		expect(await headerFor("en-US")).toBe("en-US,en;q=0.9,en;q=0.8");
		expect(await headerFor("pt-BR")).toBe("pt-BR,pt;q=0.9,en;q=0.8");
		expect(await headerFor("es")).toBe("es,en;q=0.8");
		expect(await headerFor()).toBe("en");
		expect(acceptLanguageFor("auto")).toBe("en");
		expect(acceptLanguageFor("x\r\nHost: evil")).toBe("en");
	});
});

describe("adaptador web: extração", () => {
	it("devolve a página inteira com o limite técnico pedido à lib (sem corte por economia)", async () => {
		const extract = vi.fn<ExtractPageFn>(async (url) => ({ url, title: "T", markdown: "m".repeat(150_000), truncated: false }));
		const page = await createWebAdapter({ extract }).extract("owner-1", "https://a.test/p");
		expect(page.text).toHaveLength(150_000);
		expect(extract.mock.calls[0]?.[1]).toMatchObject({ maxChars: EXTRACT_TECHNICAL_MAX_CHARS, timeoutMs: 30_000 });
	});

	it("avisa quando passou do limite técnico da leitura", async () => {
		const extract: ExtractPageFn = async (url) => ({ url, markdown: "corpo", truncated: true });
		const page = await createWebAdapter({ extract }).extract("owner-1", "https://a.test/p");
		expect(page.text).toContain("longer than the technical reading limit");
	});

	it("SSRF: URL interna é barrada antes de chegar à lib", async () => {
		const extract = vi.fn<ExtractPageFn>();
		const web = createWebAdapter({ extract });
		for (const url of ["http://127.0.0.1/x", "http://169.254.169.254/latest", "file:///etc/passwd", "http://localhost:3000"]) {
			await expect(web.extract("owner-1", url)).rejects.toThrow(/give a public http\(s\) page URL/);
		}
		expect(extract).not.toHaveBeenCalled();
	});

	it("erro da lib vira mensagem em inglês por código, sem texto de terceiro nem nome de tool do v2", async () => {
		const cases: Array<[string, RegExp]> = [
			["needs_js", /JavaScript/],
			["robots_denied", /does not allow/],
			["needs_login", /login/],
			["timeout", /too long/],
			["blocked", /could not be fetched/],
		];
		for (const [code, expected] of cases) {
			const extract: ExtractPageFn = async () => {
				throw Object.assign(new Error("requer JS — use sandbox browser"), { code, hint: "escale para navegador (navigate + browser_text)" });
			};
			const error = await createWebAdapter({ extract }).extract("owner-1", "https://a.test/p").catch((e: Error) => e);
			expect((error as Error).message).toMatch(expected);
			expect((error as Error).message).not.toMatch(/browser_text|sandbox/);
		}
		const aborted: ExtractPageFn = async () => Promise.reject(Object.assign(new Error("x"), { name: "TimeoutError" }));
		await expect(createWebAdapter({ extract: aborted }).extract("owner-1", "https://a.test/p")).rejects.toThrow(/too long/);
	});
});

describe("web ponta a ponta no kernel: página enorme é lida em partes pelo caderno", () => {
	it("web_extract de página gigante entrega a 1ª página + ponteiro e o resto vem por note_read, sem perder nada", async () => {
		const original = `${"x".repeat(DEFAULT_PAGE_CHARS * 2)}FIM-DA-PAGINA`;
		const extract: ExtractPageFn = async (url) => ({ url, markdown: original, truncated: false });
		const web = createWebCapability(createWebAdapter({ extract }));
		const h = kernelHarness(
			[reply({ calls: [call("a", "web_extract", { url: "https://a.test/grande" })] }), reply({ calls: [call("b", "note_read", { id: "work:run-1:out:a", offset: DEFAULT_PAGE_CHARS * 2 })] }), reply({ text: "ok" })],
			{ capabilities: [web] },
		);
		await h.run();
		const first = (h.llm.requests[1]?.messages.at(-1) as { content: string }).content;
		expect(first).toContain(`note_read(id="work:run-1:out:a", offset=`);
		const stored = h.notes.items.get("owner-1:work:run-1:out:a")?.body ?? "";
		expect(stored).toContain("FIM-DA-PAGINA");
		const last = (h.llm.requests[2]?.messages.at(-1) as { content: string }).content;
		expect(last).toContain("FIM-DA-PAGINA");
	});
});
