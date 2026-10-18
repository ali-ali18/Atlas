import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  extractWebPage,
  searchSearxng,
  ExtractError,
  NEEDS_JS_MESSAGE,
} from "@workspace/search";
import {
  WEB_SEARCH_DEFAULT_NUM,
  WebSearchError,
  type WebSearchArgs,
  type WebSearchResult,
} from "./web-search.js";
import {
	WEB_EXTRACT_CONCURRENCY,
	WEB_EXTRACT_MAX_URLS,
	WEB_EXTRACT_TOTAL_MAX_CHARS,
	WebExtractError,
	normalizeExtractMaxChars,
	truncateExtractContent,
	type WebExtractArgs,
	type WebExtractItem,
	type WebExtractItemError,
} from "./web-extract.js";

/**
 * Provedor NATIVO de pesquisa (sem chave, sem sandbox): o degrau que evita
 * o bot ficar refém de API paga ou do navegador do container.
 * - busca: SearXNG auto-hospedado primeiro (Atlas Search S1); scrape do
 *   DuckDuckGo só como fallback se o SearXNG estiver indisponível;
 * - extract: pipeline próprio do `@workspace/search` (Atlas Search S2:
 *   Readability→Markdown, PDF, robots, rate-limit, cache ETag) — sem JS;
 *   páginas SPA/login escalam para o navegador.
 * Segurança: só http(s) para IP público — bloqueia loopback, rede privada,
 * link-local (metadata de nuvem) inclusive após redirects.
 */

export const NATIVE_FETCH_TIMEOUT_MS = 15_000;
export const NATIVE_MAX_HTML_BYTES = 2_000_000;
const NATIVE_MAX_REDIRECTS = 5;
const NATIVE_USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const DDG_HTML_URL = "https://html.duckduckgo.com/html/";

export type NativeFetchFn = (input: string, init?: RequestInit) => Promise<Response>;
export type NativeLookupFn = (hostname: string) => Promise<string[]>;

export type NativeOptions = {
  fetchFn?: NativeFetchFn;
  lookupFn?: NativeLookupFn;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Override do SearXNG (padrão: `SEARXNG_BASE_URL` do env). */
  searxngBaseUrl?: string;
};

const defaultLookup: NativeLookupFn = async (hostname) =>
	(await dnsLookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

// ---------------------------------------------------------------- SSRF guard

function ipv4ToInt(ip: string): number {
	return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function inV4Range(ip: string, base: string, bits: number): boolean {
	const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
	return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

const BLOCKED_V4: Array<[string, number]> = [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
];

export function isPrivateAddress(address: string): boolean {
	const version = isIP(address);
	if (version === 4) {
		return BLOCKED_V4.some(([base, bits]) => inV4Range(address, base, bits));
	}
	if (version === 6) {
		const lower = address.toLowerCase();
		const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
		if (mapped?.[1]) return isPrivateAddress(mapped[1]);
		return (
			lower === "::" ||
			lower === "::1" ||
			/^f[cd][0-9a-f]{2}:/.test(lower) ||
			/^fe[89ab][0-9a-f]:/.test(lower) ||
			lower.startsWith("ff")
		);
	}
	return true;
}

export async function assertPublicUrl(
	raw: string,
	lookupFn: NativeLookupFn = defaultLookup,
): Promise<URL> {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new WebExtractError("empty", `URL inválida: ${raw.slice(0, 200)}`, "corrija a URL ou use web_search");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new WebExtractError("blocked", `protocolo não permitido: ${url.protocol}`, "use uma URL http(s)");
	}
	const host = url.hostname.replace(/^\[|\]$/g, "");
	if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
		throw new WebExtractError("blocked", "endereço interno não permitido", "use uma URL pública");
	}
	const addresses = isIP(host) ? [host] : await lookupFn(host).catch(() => []);
	if (addresses.length === 0) {
		throw new WebExtractError("empty", `domínio não resolve: ${host}`, "confira a URL ou tente web_search");
	}
	if (addresses.some(isPrivateAddress)) {
		throw new WebExtractError("blocked", "endereço interno não permitido", "use uma URL pública");
	}
	return url;
}

// ---------------------------------------------------------------- fetch

function linkedSignal(parent: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
	if (!response.body) return response.text();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (total < maxBytes) {
		const { done, value } = await reader.read();
		if (done || !value) break;
		chunks.push(value);
		total += value.byteLength;
	}
	await reader.cancel().catch(() => undefined);
	return new TextDecoder("utf-8").decode(Buffer.concat(chunks).subarray(0, maxBytes));
}

/** GET seguindo redirects manualmente (cada salto repassa pelo guard SSRF). */
async function safeFetch(
	rawUrl: string,
	options: NativeOptions,
): Promise<{ response: Response; finalUrl: string }> {
	const fetchFn = options.fetchFn ?? (globalThis.fetch as NativeFetchFn);
	const signal = linkedSignal(options.signal, options.timeoutMs ?? NATIVE_FETCH_TIMEOUT_MS);
	let current = rawUrl;
	for (let hop = 0; hop <= NATIVE_MAX_REDIRECTS; hop += 1) {
		const url = await assertPublicUrl(current, options.lookupFn);
		const response = await fetchFn(url.toString(), {
			method: "GET",
			redirect: "manual",
			signal,
			headers: {
				"User-Agent": NATIVE_USER_AGENT,
				Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
				"Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
			},
		});
		const location = response.headers.get("location");
		if (response.status >= 300 && response.status < 400 && location) {
			current = new URL(location, url).toString();
			continue;
		}
		return { response, finalUrl: url.toString() };
	}
	throw new WebExtractError("blocked", "redirecionamentos demais", "escale para navegador (navigate + browser_text)");
}

// ---------------------------------------------------------------- HTML → texto

const ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	ndash: "–",
	mdash: "—",
	hellip: "…",
	laquo: "«",
	raquo: "»",
	copy: "©",
	reg: "®",
	euro: "€",
};

export function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
		if (code[0] === "#") {
			const value = code[1]?.toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
			return Number.isFinite(value) && value > 0 && value < 0x110000 ? String.fromCodePoint(value) : match;
		}
		return ENTITIES[code.toLowerCase()] ?? match;
	});
}

const INLINE_TAGS = /<\/?(b|i|u|em|strong|span|small|mark|sup|sub|abbr|code|s|a)\b[^>]*>/gi;

function stripTags(html: string): string {
	return decodeEntities(html.replace(INLINE_TAGS, "").replace(/<[^>]+>/g, " "))
		.replace(/\s+/g, " ")
		.trim();
}

function pickMainHtml(html: string): string {
	for (const tag of ["article", "main"]) {
		const match = html.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
		if (match?.[1] && stripTags(match[1]).length >= 400) return match[1];
	}
	const body = html.match(/<body\b[^>]*>([\s\S]*)<\/body>/i);
	return body?.[1] ?? html;
}

/** HTML → markdown simples (títulos, listas, parágrafos, links absolutos). */
export function htmlToText(html: string, baseUrl?: string): { title?: string; text: string } {
	const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
	const title = titleMatch?.[1] ? stripTags(titleMatch[1]) || undefined : undefined;
	let body = html
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<(script|style|noscript|svg|template|iframe|canvas|head)\b[\s\S]*?<\/\1>/gi, " ");
	body = pickMainHtml(body)
		.replace(/<(nav|footer|aside|form|dialog)\b[\s\S]*?<\/\1>/gi, " ")
		.replace(/<a\b[^>]*href\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
			const text = stripTags(inner);
			if (!text) return " ";
			try {
				const absolute = new URL(decodeEntities(href), baseUrl).toString();
				return /^https?:/.test(absolute) ? ` [${text}](${absolute}) ` : ` ${text} `;
			} catch {
				return ` ${text} `;
			}
		})
		.replace(/<h([1-6])\b[^>]*>/gi, (_m, level: string) => `\n\n${"#".repeat(Number(level))} `)
		.replace(/<\/h[1-6]>/gi, "\n\n")
		.replace(/<li\b[^>]*>/gi, "\n- ")
		.replace(/<(br|hr)\b[^>]*\/?>/gi, "\n")
		.replace(/<\/?(p|div|section|article|main|header|ul|ol|table|tr|blockquote|pre|figure|figcaption|dl|dt|dd)\b[^>]*>/gi, "\n")
		.replace(/<\/?(td|th)\b[^>]*>/gi, " | ")
		.replace(INLINE_TAGS, "")
		.replace(/<[^>]+>/g, " ");
	const lines = decodeEntities(body)
		.split("\n")
		.map((line) => line.replace(/[ \t ]+/g, " ").trim());
	const text = collapseLinkRuns(lines)
		.filter((line, index, all) => line !== "" || all[index - 1] !== "")
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return { title, text };
}

const LINK_ONLY_LINE = /^(?:- )?\[[^\]]*\]\([^)]*\)$/;
const LINK_RUN_MIN = 5;

/** Menus/listas de idiomas: 5+ linhas seguidas só de link viram um marcador. */
function collapseLinkRuns(lines: string[]): string[] {
	const out: string[] = [];
	let run: string[] = [];
	const flush = () => {
		if (run.length >= LINK_RUN_MIN) out.push(`[${run.length} links omitidos]`);
		else out.push(...run);
		run = [];
	};
	for (const line of lines) {
		if (LINK_ONLY_LINE.test(line)) {
			run.push(line);
		} else if (line === "" && run.length > 0) {
			continue;
		} else {
			flush();
			out.push(line);
		}
	}
	flush();
	return out;
}

// ---------------------------------------------------------------- extract

function itemError(code: WebExtractItemError["code"], message: string, escalateHint: string): WebExtractItemError {
	return { code, message, escalateHint };
}

const BROWSER_HINT = "escale para navegador (navigate + browser_text)";

/** Extract nativo via pipeline próprio (S2) — mesma forma de saída do extract via API (sem `schema`). */
async function extractOne(url: string, maxChars: number, options: NativeOptions): Promise<WebExtractItem> {
  const fetchedAt = new Date().toISOString();
  try {
    const page = await extractWebPage(url, {
      fetchFn: options.fetchFn,
      lookupFn: options.lookupFn,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      maxChars,
    });
    const capped = truncateExtractContent(page.markdown, maxChars);
    return {
      url,
      title: page.title,
      fetchedAt,
      content: capped.content,
      truncated: capped.truncated || page.truncated,
    };
  } catch (error) {
    if (error instanceof ExtractError) {
      if (error.code === "needs_js") {
        return {
          url,
          fetchedAt,
          truncated: false,
          error: itemError("empty", NEEDS_JS_MESSAGE, `${BROWSER_HINT}, motivo: página renderizada por JS`),
        };
      }
      if (error.code === "robots_denied" || error.code === "rate_limited") {
        return {
          url,
          fetchedAt,
          truncated: false,
          error: itemError("blocked", error.message, error.hint),
        };
      }
      return {
        url,
        fetchedAt,
        truncated: false,
        error: itemError(error.code, error.message, error.hint),
      };
    }
    if (error instanceof WebExtractError) {
      return { url, fetchedAt, truncated: false, error: itemError(error.code, error.message, error.escalateHint) };
    }
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return {
      url,
      fetchedAt,
      truncated: false,
      error: timedOut
        ? itemError("timeout", "tempo esgotado", `${BROWSER_HINT}, motivo: timeout`)
        : itemError("blocked", error instanceof Error ? error.message.slice(0, 200) : "falha de rede", `${BROWSER_HINT}, motivo: falha de rede`),
    };
  }
}

/** Extract nativo: mesma forma de saída do extract via API (sem `schema`). */
export async function nativeWebExtract(args: WebExtractArgs, options: NativeOptions = {}): Promise<WebExtractItem[]> {
	const urls = (args.urls ?? []).map((url) => String(url ?? "").trim());
	if (urls.length === 0 || urls.some((url) => !url)) {
		throw new WebExtractError("empty", "urls vazio ou com URL em branco (máx. 5 por chamada)", "tente web_search com outra query");
	}
	if (urls.length > WEB_EXTRACT_MAX_URLS) {
		throw new WebExtractError("blocked", `máximo de ${WEB_EXTRACT_MAX_URLS} URLs por chamada (recebido ${urls.length})`, "divida em chamadas de até 5 URLs");
	}
	const maxChars = Math.min(
		normalizeExtractMaxChars(args.maxChars),
		Math.floor(WEB_EXTRACT_TOTAL_MAX_CHARS / urls.length),
	);
	const results: WebExtractItem[] = new Array(urls.length);
	for (let start = 0; start < urls.length; start += WEB_EXTRACT_CONCURRENCY) {
		const chunk = urls.slice(start, start + WEB_EXTRACT_CONCURRENCY);
		const items = await Promise.all(chunk.map((url) => extractOne(url, maxChars, options)));
		items.forEach((item, offset) => {
			results[start + offset] = item;
		});
	}
	return results;
}

// ---------------------------------------------------------------- search

const RECENCY_TO_DF: Record<string, string> = { day: "d", week: "w", month: "m", year: "y" };

function localeToRegion(locale: string | undefined): string {
	const [lang, country] = (locale ?? "pt-BR").toLowerCase().split(/[-_]/);
	return country ? `${country}-${lang}` : "wt-wt";
}

function unwrapDuckUrl(href: string, depth = 0): string | null {
	const absolute = href.startsWith("//") ? `https:${href}` : href;
	try {
		const url = new URL(absolute, "https://duckduckgo.com");
		if (url.hostname.endsWith("duckduckgo.com")) {
			if (url.pathname.startsWith("/y.js")) return null; // anúncio
			const target = url.searchParams.get("uddg");
			// Anúncio real vem embrulhado 2x: uddg → duckduckgo.com/y.js?ad_domain=…
			return target && depth < 2 && /^https?:/.test(target)
				? unwrapDuckUrl(target, depth + 1)
				: null;
		}
		return /^https?:/.test(url.toString()) ? url.toString() : null;
	} catch {
		return null;
	}
}

/** Resultados da página HTML do DuckDuckGo (puro, testável). */
export function parseDuckDuckGoHtml(html: string, num = WEB_SEARCH_DEFAULT_NUM): WebSearchResult[] {
	const results: WebSearchResult[] = [];
	const seen = new Set<string>();
	const blocks = html.split(/<div[^>]+class="[^"]*\bresult\b/i).slice(1);
	for (const block of blocks) {
		if (/result--ad\b/i.test(block.slice(0, 200))) continue;
		const link = block.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
			?? block.match(/<a[^>]+href="([^"]+)"[^>]+class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
		if (!link?.[1]) continue;
		const url = unwrapDuckUrl(decodeEntities(link[1]));
		if (!url || seen.has(url)) continue;
		const snippet = block.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/i);
		seen.add(url);
		results.push({
			url,
			title: stripTags(link[2] ?? "") || url,
			snippet: snippet?.[1] ? stripTags(snippet[1]) : "",
			source: "duckduckgo",
		});
		if (results.length >= num) break;
	}
	return results;
}

export async function nativeWebSearch(args: WebSearchArgs, options: NativeOptions = {}): Promise<WebSearchResult[]> {
  const query = String(args.query ?? "").trim();
  if (!query) {
    throw new WebSearchError("empty", "query vazia", "informe o que buscar");
  }
  const num = Math.max(1, Math.min(10, Math.floor(args.num ?? WEB_SEARCH_DEFAULT_NUM)));
  // S1: SearXNG primeiro; DuckDuckGo direto só como fallback se o SearXNG
  // estiver indisponível (sem `SEARXNG_BASE_URL`) ou falhar.
  const searxngBase = (options.searxngBaseUrl ?? process.env.SEARXNG_BASE_URL ?? "").trim();
  if (searxngBase) {
    try {
      const hits = await searchSearxng(query, {
        baseUrl: searxngBase,
        num,
        language: args.locale,
        timeRange: args.recency,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        fetchFn: options.fetchFn,
      });
      return hits.map((hit) => ({
        url: hit.url,
        title: hit.title,
        snippet: hit.snippet,
        source: hit.engine ? `searxng:${hit.engine}` : "searxng",
      }));
    } catch {
      // Cai para o DuckDuckGo direto abaixo.
    }
  }
  const params = new URLSearchParams({ q: query, kl: localeToRegion(args.locale) });
	const df = args.recency ? RECENCY_TO_DF[args.recency.toLowerCase()] : undefined;
	if (df) params.set("df", df);
	const fetchFn = options.fetchFn ?? (globalThis.fetch as NativeFetchFn);
	let html: string;
	try {
		const response = await fetchFn(`${DDG_HTML_URL}?${params.toString()}`, {
			method: "GET",
			signal: linkedSignal(options.signal, options.timeoutMs ?? NATIVE_FETCH_TIMEOUT_MS),
			headers: { "User-Agent": NATIVE_USER_AGENT, "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8" },
		});
		if (response.status === 202 || response.status === 403 || response.status === 429) {
			throw new WebSearchError("blocked", `busca nativa limitada (HTTP ${response.status})`, `${BROWSER_HINT} com https://duckduckgo.com/?q=... ou https://www.bing.com/search?q=...`);
		}
		if (!response.ok) {
			throw new WebSearchError("blocked", `busca nativa falhou (HTTP ${response.status})`, BROWSER_HINT);
		}
		html = await readCapped(response, NATIVE_MAX_HTML_BYTES);
	} catch (error) {
		if (error instanceof WebSearchError) throw error;
		const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
		throw new WebSearchError(timedOut ? "timeout" : "blocked", timedOut ? "busca nativa: tempo esgotado" : "busca nativa: falha de rede", BROWSER_HINT);
	}
	if (/anomaly-modal|captcha/i.test(html)) {
		throw new WebSearchError("blocked", "busca nativa pediu verificação (captcha)", `${BROWSER_HINT} com https://www.bing.com/search?q=...`);
	}
	const results = parseDuckDuckGoHtml(html, num);
	if (results.length === 0) {
		throw new WebSearchError("empty", "nenhum resultado", "tente outra query (termos mais gerais) ou o navegador");
	}
	return results;
}
