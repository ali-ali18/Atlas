import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseAlertRule, type AlertRule, type AlertSource } from "@workspace/shared";
import { clearExtractRobotsCache } from "./extract.js";
import * as sourceModule from "./alert-source.js";
import { createAlertSourceCache, ALERT_SOURCE_UA, ALERT_SOURCE_MAX_BYTES, type AlertSourceDeps } from "./alert-source.js";

// Os testes de segurança e leitura não dependem do robots.txt (ele tem os seus testes abaixo).
const readAlertSource = (source: Parameters<typeof sourceModule.readAlertSource>[0], deps: AlertSourceDeps = {}, wantList?: boolean) => sourceModule.readAlertSource(source, { respectRobots: false, ...deps }, wantList);
const readAlertRule = (rule: Parameters<typeof sourceModule.readAlertRule>[0], deps: AlertSourceDeps = {}) => sourceModule.readAlertRule(rule, { respectRobots: false, ...deps });

const PUBLIC_IP = ["93.184.216.34"];
const lookupPublic = async () => PUBLIC_IP;

function res(body: string, init: { status?: number; headers?: Record<string, string> } = {}): Response {
	return new Response(body, { status: init.status ?? 200, headers: init.headers });
}
const page = (extract: object): AlertSource => ({ type: "page", url: "https://loja.example.com/p?token=segredo", extract: extract as never });
const css = page({ kind: "css", selector: "span.price" });

beforeEach(() => clearExtractRobotsCache());

describe("readAlertSource · segurança (SSRF)", () => {
	const blocked = async (url: string, lookupFn = lookupPublic) => {
		const fetchFn = vi.fn(async () => res("x"));
		const result = await readAlertSource({ type: "page", url, extract: { kind: "regex", pattern: "x" } }, { fetchFn, lookupFn });
		return { result, fetchFn };
	};

	it.each([
		["http://127.0.0.1/admin"],
		["http://localhost:8080/"],
		["http://10.0.0.5/"],
		["http://192.168.1.10/"],
		["http://169.254.169.254/latest/meta-data/"],
		["http://[::1]/"],
		["http://[fd00::1]/"],
		["http://metadata.internal/"],
		["file:///etc/passwd"],
		["ftp://example.com/x"],
		["javascript:alert(1)"],
	])("recusa %s sem fazer a requisição", async (url) => {
		const { result, fetchFn } = await blocked(url);
		expect(result).toMatchObject({ ok: false, code: "blocked" });
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("recusa domínio público que resolve para IP privado (DNS apontando para dentro)", async () => {
		const { result, fetchFn } = await blocked("https://evil.example.com/", async () => ["10.1.2.3"]);
		expect(result).toMatchObject({ ok: false, code: "blocked" });
		expect(fetchFn).not.toHaveBeenCalled();
		const mixed = await blocked("https://evil.example.com/", async () => ["93.184.216.34", "169.254.169.254"]);
		expect(mixed.result).toMatchObject({ ok: false, code: "blocked" });
	});

	it("recusa redirect para endereço privado (cada salto passa pelo guard)", async () => {
		const fetchFn = vi.fn(async (url: string) => (url.startsWith("https://ok.example.com") ? res("", { status: 302, headers: { location: "http://169.254.169.254/latest" } }) : res("segredo")));
		const result = await readAlertSource({ type: "page", url: "https://ok.example.com/", extract: { kind: "regex", pattern: "x" } }, { fetchFn: fetchFn as never, lookupFn: lookupPublic });
		expect(result).toMatchObject({ ok: false, code: "blocked" });
		expect(fetchFn).toHaveBeenCalledTimes(1);
	});

	it("redirect para host que só resolve para privado também é recusado", async () => {
		const lookupFn = async (host: string) => (host === "interno.example.com" ? ["10.0.0.9"] : PUBLIC_IP);
		const fetchFn = vi.fn(async () => res("", { status: 301, headers: { location: "https://interno.example.com/" } }));
		const result = await readAlertSource(css, { fetchFn: fetchFn as never, lookupFn });
		expect(result).toMatchObject({ ok: false, code: "blocked" });
	});

	it("no máximo 3 redirects", async () => {
		let n = 0;
		const fetchFn = vi.fn(async () => res("", { status: 302, headers: { location: `https://a.example.com/${(n += 1)}` } }));
		const result = await readAlertSource(css, { fetchFn: fetchFn as never, lookupFn: lookupPublic });
		expect(result).toMatchObject({ ok: false, code: "blocked", reason: "redirecionamentos demais" });
		expect(fetchFn).toHaveBeenCalledTimes(4);
	});

	it("segue redirect público e manda o User-Agent honesto, sem cookies nem autorização", async () => {
		const seen: Array<Record<string, string>> = [];
		const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
			seen.push(init?.headers as Record<string, string>);
			return url.endsWith("/p") ? res("", { status: 301, headers: { location: "/novo" } }) : res('<span class="price">R$ 449,90</span>');
		});
		const result = await readAlertSource({ type: "page", url: "https://loja.example.com/p", extract: { kind: "css", selector: "span.price" } }, { fetchFn: fetchFn as never, lookupFn: lookupPublic });
		expect(result).toMatchObject({ ok: true, read: { kind: "text", text: "R$ 449,90" }, host: "loja.example.com" });
		expect(seen[0]!["User-Agent"]).toBe(ALERT_SOURCE_UA);
		expect(Object.keys(seen[0]!).map((k) => k.toLowerCase())).not.toContain("cookie");
		expect(Object.keys(seen[0]!).map((k) => k.toLowerCase())).not.toContain("authorization");
	});
});

describe("readAlertSource · limites", () => {
	it("aceita página de 2,2 MB (limite de 5 MB) e mantém o teto", async () => {
		expect(ALERT_SOURCE_MAX_BYTES).toBe(5_000_000);
		const big = `<html><body><span class="p">R$ 21,34</span>${"x".repeat(2_220_000)}</body></html>`;
		const ok = vi.fn(async () => res(big));
		expect(await readAlertSource(css, { fetchFn: ok as never, lookupFn: lookupPublic })).toMatchObject({ ok: true });
	});

	it("recusa corpo acima do limite (declarado e em stream)", async () => {
		const declared = vi.fn(async () => res("x", { headers: { "content-length": "5000001" } }));
		expect(await readAlertSource(css, { fetchFn: declared as never, lookupFn: lookupPublic })).toMatchObject({ ok: false, code: "too_large" });
		const streamed = vi.fn(async () => res("a".repeat(3000)));
		expect(await readAlertSource(css, { fetchFn: streamed as never, lookupFn: lookupPublic, maxBytes: 1000 })).toMatchObject({ ok: false, code: "too_large" });
	});

	it("estoura o tempo quando o site não responde", async () => {
		const fetchFn = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "TimeoutError")))));
		const result = await readAlertSource(css, { fetchFn: fetchFn as never, lookupFn: lookupPublic, timeoutMs: 30 });
		expect(result).toMatchObject({ ok: false, code: "timeout" });
	});

	it("HTTP de erro e falha de rede viram motivo simples, sem a URL (pode ter chave na query)", async () => {
		const forbidden = await readAlertSource(css, { fetchFn: (async () => res("no", { status: 403 })) as never, lookupFn: lookupPublic });
		expect(forbidden).toMatchObject({ ok: false, code: "http", reason: expect.stringContaining("403") });
		const boom = await readAlertSource(css, { fetchFn: (async () => { throw new Error("ECONNRESET https://loja.example.com/p?token=segredo"); }) as never, lookupFn: lookupPublic });
		expect(boom).toMatchObject({ ok: false, code: "network" });
		expect(JSON.stringify(boom)).not.toContain("segredo");
	});
});

describe("readAlertSource · leitura", () => {
	const html = '<html><body><div class="p"><span class="price" content="449.90">R$ 449,90</span></div><ul><li class="ed"><a href="/e/1">Edital 1</a></li><li class="ed"><a href="/e/2">Edital 2</a></li></ul></body></html>';
	const deps = { fetchFn: (async () => res(html)) as never, lookupFn: lookupPublic };

	it("css (texto e atributo), regex e jsonpath", async () => {
		expect(await readAlertSource(css, deps)).toMatchObject({ ok: true, read: { text: "R$ 449,90" } });
		expect(await readAlertSource(page({ kind: "css", selector: "span.price", attribute: "content" }), deps)).toMatchObject({ read: { text: "449.90" } });
		expect(await readAlertSource(page({ kind: "css", selector: "span.nada" }), deps)).toMatchObject({ ok: true, read: { text: null } });
		expect(await readAlertSource(page({ kind: "regex", pattern: "R\\$\\s*([\\d.,]+)" }), deps)).toMatchObject({ read: { text: "449,90" } });
		const json = { fetchFn: (async () => res('{"data":{"price":12.5}}')) as never, lookupFn: lookupPublic };
		expect(await readAlertSource(page({ kind: "jsonpath", path: "$.data.price" }), json)).toMatchObject({ read: { text: "12.5" } });
		expect(await readAlertSource(page({ kind: "jsonpath", path: "$.data.price" }), deps)).toMatchObject({ ok: false, code: "parse" });
	});

	it("seletor inválido não derruba", async () => {
		expect(await readAlertSource(page({ kind: "css", selector: "span[[" }), deps)).toMatchObject({ ok: false, code: "parse" });
	});

	it("lista de itens por seletor (novo item em página) com link absoluto", async () => {
		const rule = (parseAlertRule({ source: page({ kind: "css", selector: "li.ed" }), check: { kind: "new_item" } }) as { ok: true; rule: AlertRule }).rule;
		const result = await readAlertRule(rule, deps);
		expect(result).toMatchObject({ ok: true, read: { kind: "items", items: [{ title: "Edital 1", link: "https://loja.example.com/e/1" }, { title: "Edital 2" }] } });
	});

	it("feed RSS; página comum num feed vira erro claro", async () => {
		const rss = '<?xml version="1.0"?><rss><channel><item><title>A</title><guid>1</guid></item></channel></rss>';
		const feed: AlertSource = { type: "feed", url: "https://blog.example.com/feed" };
		expect(await readAlertSource(feed, { fetchFn: (async () => res(rss)) as never, lookupFn: lookupPublic })).toMatchObject({ ok: true, read: { items: [{ id: "1", title: "A" }] } });
		expect(await readAlertSource(feed, deps)).toMatchObject({ ok: false, code: "parse" });
	});
});

describe("cache por ciclo", () => {
	it("alertas na mesma URL buscam uma vez só; expira depois do TTL", async () => {
		const fetchFn = vi.fn(async () => res('<span class="price">R$ 10,00</span>'));
		const cache = createAlertSourceCache();
		let now = 1_000;
		const deps = { fetchFn: fetchFn as never, lookupFn: lookupPublic, cache, now: () => now };
		await Promise.all([readAlertSource(css, deps), readAlertSource(page({ kind: "css", selector: "span.price", attribute: "x" }), deps), readAlertSource(css, deps)]);
		expect(fetchFn).toHaveBeenCalledTimes(1);
		now += 61_000;
		await readAlertSource(css, deps);
		expect(fetchFn).toHaveBeenCalledTimes(2);
	});
});

describe("robots.txt", () => {
	const robotsFor = (txt: string, status = 200) =>
		vi.fn(async (url: string) => (url.endsWith("/robots.txt") ? res(txt, { status, headers: { "content-type": "text/plain" } }) : res('<span class="price">R$ 10,00</span>')));

	it("respeita Disallow e nem baixa a página", async () => {
		const fetchFn = robotsFor("User-agent: *\nDisallow: /p");
		const result = await sourceModule.readAlertSource(css, { fetchFn: fetchFn as never, lookupFn: lookupPublic });
		expect(result).toMatchObject({ ok: false, code: "blocked", reason: expect.stringContaining("robots.txt") });
		expect(fetchFn.mock.calls.map((call) => call[0])).toEqual(["https://loja.example.com/robots.txt"]);
	});

	it("sem robots.txt (404) ou com caminho liberado a leitura segue", async () => {
		expect(await sourceModule.readAlertSource(css, { fetchFn: robotsFor("", 404) as never, lookupFn: lookupPublic })).toMatchObject({ ok: true });
		clearExtractRobotsCache();
		expect(await sourceModule.readAlertSource(css, { fetchFn: robotsFor("User-agent: *\nDisallow: /admin") as never, lookupFn: lookupPublic })).toMatchObject({ ok: true });
	});
});

describe("readAlertRule · fontes de mercado", () => {
	it("câmbio passa pelo provedor de host fixo, sem tocar no guard de URL", async () => {
		const fetchFn = vi.fn(async () => new Response(JSON.stringify({ USDBRL: { bid: "5.97", timestamp: "1793116800" } }), { status: 200 }));
		const rule = { source: { type: "fx", pair: "USD-BRL" }, check: { kind: "value", parse: "money", op: "gt", value: 6, currency: "BRL" } } as AlertRule;
		const result = await readAlertRule(rule, { market: { fetchFn: fetchFn as never } });
		expect(result).toMatchObject({ ok: true, host: "economia.awesomeapi.com.br", read: { kind: "number", value: 5.97 } });
		expect(fetchFn).toHaveBeenCalledTimes(1);
	});
	it("cotação sem chave do dono falha com a dica do Marketplace", async () => {
		const rule = { source: { type: "quote", symbol: "BBAS3" }, check: { kind: "value", parse: "money", op: "lt", value: 15, currency: "BRL" } } as AlertRule;
		expect(await readAlertRule(rule, { market: { getKeys: () => ({}) } })).toMatchObject({ ok: false, code: "needs_key" });
	});
});

describe("readAlertRule · teto de memória do cache", () => {
	it("passa de 100 MB (padrão) ou do teto dado: os mais antigos saem e o cache nunca estoura", async () => {
		expect(sourceModule.ALERT_SOURCE_CACHE_MAX_BYTES).toBe(100_000_000);
		const cache = createAlertSourceCache();
		const fetchFn = vi.fn(async () => res(`<span class="p">R$ 1,00</span>${"x".repeat(400)}`));
		const deps = { fetchFn: fetchFn as never, lookupFn: lookupPublic, cache, cacheMaxBytes: 2000 };
		for (const id of [1, 2, 3, 4]) await readAlertSource({ type: "page", url: `https://loja.example.com/p${id}`, extract: { kind: "css", selector: "span.p" } }, deps);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const total = [...cache.values()].reduce((sum, entry) => sum + (entry.bytes ?? 0), 0);
		expect(total).toBeLessThanOrEqual(2000);
		expect(cache.size).toBeLessThan(4);
		expect(cache.has("https://loja.example.com/p4")).toBe(true);
		expect(cache.has("https://loja.example.com/p1")).toBe(false);
	});

	it("página que falha não fica no cache", async () => {
		const cache = createAlertSourceCache();
		const fetchFn = vi.fn(async () => res("", { status: 500 }));
		await readAlertSource({ type: "page", url: "https://loja.example.com/x", extract: { kind: "css", selector: "span" } }, { fetchFn: fetchFn as never, lookupFn: lookupPublic, cache });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(cache.size).toBe(0);
	});

	it("seletor CSS devolve também o contexto em volta (o rótulo do card), para a âncora da regra", async () => {
		const html = '<div class="_card cotacao"><div class="_card-header"><span>Cotação</span></div><div class="_card-body"><span class="value">R$ 16,47</span></div></div><div class="_card dy"><span>Dividend Yield</span><span class="value">4,14%</span></div>';
		const fetchFn = vi.fn(async () => res(html));
		const result = await readAlertSource({ type: "page", url: "https://loja.example.com/p", extract: { kind: "css", selector: "div.cotacao span.value" } }, { fetchFn: fetchFn as never, lookupFn: lookupPublic });
		expect(result).toMatchObject({ ok: true, read: { kind: "text", text: "R$ 16,47" } });
		const read = (result as { read: { context?: string } }).read;
		expect(read.context).toContain("Cotação");
		expect(read.context).not.toContain("Dividend");
		// seletor que deixa de casar: sem texto e sem contexto
		const none = await readAlertSource({ type: "page", url: "https://loja.example.com/p", extract: { kind: "css", selector: "div.cotacao span.nada" } }, { fetchFn: fetchFn as never, lookupFn: lookupPublic });
		expect(none).toMatchObject({ ok: true, read: { kind: "text", text: null } });
		expect((none as { read: { context?: string } }).read.context).toBeUndefined();
	});
});
