/**
 * Atlas Search S2 — extração própria de páginas (sem Firecrawl).
 *
 * Pipeline:
 * - fetch (global — no Node 20+ é `undici`) com guard SSRF, limite de
 *   tamanho, redirects manuais e cache condicional ETag/If-Modified-Since;
 * - `robots.txt` respeitado (check simples com cache);
 * - User-Agent identificado + rate-limit por domínio em memória;
 * - HTML → Markdown via `@mozilla/readability` + `linkedom` + `turndown`;
 * - PDF via `pdf-parse`;
 * - página sem conteúdo útil → erro claro "requer JS — use sandbox browser"
 *   (NÃO implementamos Playwright aqui; o navegador da sandbox cobre).
 *
 * Notas de escopo:
 * - O guard SSRF é uma réplica intencional do que existe em
 *   `packages/agent-runtime/src/web-native.ts`: `packages/search` não pode
 *   importar do agent-runtime (que por sua vez depende daqui — ciclo).
 * - Cache é em memória com TTL simples — sem tabelas novas. S3 fará o
 *   índice persistente (Postgres WebPage/WebChunk).
 * - Extração estruturada (`schema`) continua ignorada nesta etapa — S4 fará
 *   via LLM sobre o Markdown limpo.
 */

import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
// pdf-parse não distribui tipos próprios (@types/pdf-parse não existe para
// esta versão). O @ts-expect-error fica no import para valer em qualquer
// programa que compile este arquivo (o .d.ts ambiente não viajaria para
// dependentes como o agent-runtime).
// @ts-expect-error pdf-parse sem tipos
import pdfParseRaw from "pdf-parse";

type PdfParseFn = (data: Buffer | Uint8Array) => Promise<{ text: string }>;
const pdfParse: PdfParseFn = pdfParseRaw;

export type ExtractErrorCode =
  | "blocked"
  | "needs_login"
  | "empty"
  | "timeout"
  | "needs_js"
  | "robots_denied"
  | "rate_limited";

export class ExtractError extends Error {
  readonly code: ExtractErrorCode;
  readonly hint: string;

  constructor(code: ExtractErrorCode, message: string, hint: string) {
    super(message);
    this.name = "ExtractError";
    this.code = code;
    this.hint = hint;
  }
}

export type ExtractedPage = {
  /** URL final (após redirects). */
  url: string;
  title?: string;
  /** Conteúdo principal em Markdown (ou texto cru para txt/json/xml). */
  markdown: string;
  truncated: boolean;
  fetchedAt: string;
  /** Veio do cache condicional (304 ou TTL) — S3 persistirá isso no Postgres. */
  fromCache?: boolean;
};

export type ExtractFetchFn = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;
export type ExtractLookupFn = (hostname: string) => Promise<string[]>;

export type ExtractWebPageOptions = {
  fetchFn?: ExtractFetchFn;
  lookupFn?: ExtractLookupFn;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Teto de chars do Markdown; padrão 8000. */
  maxChars?: number;
};

export const EXTRACT_TIMEOUT_MS = 15_000;
export const EXTRACT_MAX_BYTES = 2_000_000;
export const EXTRACT_MAX_REDIRECTS = 5;
export const EXTRACT_DEFAULT_MAX_CHARS = 8000;
export const EXTRACT_TRUNCATED_SUFFIX = "\n[truncado...]";
/** Abaixo disso, a página provavelmente renderiza via JS. */
export const EXTRACT_MIN_TEXT_CHARS = 200;
export const EXTRACT_UA =
  "AtlasSearch/1.0 (+http://localhost:3000; contact: atlas@localhost) Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
/** Rate-limit por domínio: 8 extrações por janela de 10 s. */
export const EXTRACT_RATE_MAX = 8;
export const EXTRACT_RATE_WINDOW_MS = 10_000;
/** Cache condicional em memória: revalida após 5 min. */
export const EXTRACT_CACHE_TTL_MS = 5 * 60_000;
/** Cache do robots.txt por origem: 1 h. */
export const ROBOTS_CACHE_TTL_MS = 60 * 60_000;

const BROWSER_HINT = "escale para navegador (navigate + browser_text)";
export const NEEDS_JS_MESSAGE = "requer JS — use sandbox browser";

const defaultLookup: ExtractLookupFn = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map(
    (entry) => entry.address,
  );

// ---------------------------------------------------------------- SSRF guard
// Réplica de `packages/agent-runtime/src/web-native.ts` (ver nota no topo).

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

export function isPrivateExtractAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    return BLOCKED_V4.some(([base, bits]) => inV4Range(address, base, bits));
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1]) return isPrivateExtractAddress(mapped[1]);
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

export async function assertPublicExtractUrl(
  raw: string,
  lookupFn: ExtractLookupFn = defaultLookup,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ExtractError(
      "empty",
      `URL inválida: ${raw.slice(0, 200)}`,
      "corrija a URL ou use web_search",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ExtractError(
      "blocked",
      `protocolo não permitido: ${url.protocol}`,
      "use uma URL http(s)",
    );
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal")
  ) {
    throw new ExtractError(
      "blocked",
      "endereço interno não permitido",
      "use uma URL pública",
    );
  }
  const addresses = isIP(host) ? [host] : await lookupFn(host).catch(() => []);
  if (addresses.length === 0) {
    throw new ExtractError(
      "empty",
      `domínio não resolve: ${host}`,
      "confira a URL ou tente web_search",
    );
  }
  if (addresses.some(isPrivateExtractAddress)) {
    throw new ExtractError(
      "blocked",
      "endereço interno não permitido",
      "use uma URL pública",
    );
  }
  return url;
}

// ---------------------------------------------------------------- rate-limit

const rateHits = new Map<string, number[]>();

function checkExtractRateLimit(domain: string, now = Date.now()): void {
  const cutoff = now - EXTRACT_RATE_WINDOW_MS;
  const hits = (rateHits.get(domain) ?? []).filter((at) => at > cutoff);
  if (hits.length >= EXTRACT_RATE_MAX) {
    rateHits.set(domain, hits);
    throw new ExtractError(
      "rate_limited",
      `rate limit por domínio: ${domain} (${EXTRACT_RATE_MAX}/${EXTRACT_RATE_WINDOW_MS / 1000}s)`,
      `${BROWSER_HINT}, motivo: rate limit do extrator`,
    );
  }
  hits.push(now);
  rateHits.set(domain, hits);
}

/** Só para testes. */
export function clearExtractRateLimits(): void {
  rateHits.clear();
}

// ---------------------------------------------------------------- robots.txt

type RobotsCacheEntry = { rules: string[]; expiresAt: number };
const robotsCache = new Map<string, RobotsCacheEntry>();

function parseRobotsForUs(txt: string): string[] {
  const lines = txt.split(/\r?\n/);
  let inOurs = false;
  let inStar = false;
  const ours: string[] = [];
  const star: string[] = [];
  for (const raw of lines) {
    const line = raw.split("#")[0]?.trim() ?? "";
    if (!line) continue;
    const agent = line.match(/^user-agent\s*:\s*(.+)$/i)?.[1]?.trim().toLowerCase();
    if (agent !== undefined) {
      inOurs = agent === "atlassearch" || agent === "atlas";
      inStar = agent === "*";
      continue;
    }
    const disallow = line.match(/^disallow\s*:\s*(.*)$/i)?.[1]?.trim();
    if (disallow !== undefined) {
      if (inOurs) ours.push(disallow);
      else if (inStar) star.push(disallow);
    }
  }
  return ours.length > 0 ? ours : star;
}

function robotsRuleToRegExp(rule: string): RegExp {
  // Suporte mínimo: `*` vira `.*` (suficiente para `Disallow: /x*`); o resto é
  // prefixo literal. Regras vazias (`Disallow:`) permitem tudo.
  const escaped = rule.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}`);
}

/** Check simples de robots.txt (fail-open; cache por origem). */
export async function isAllowedByRobots(
  url: URL,
  fetchFn: ExtractFetchFn,
  signal?: AbortSignal,
  now = Date.now(),
): Promise<boolean> {
  const origin = url.origin;
  const cached = robotsCache.get(origin);
  if (cached && cached.expiresAt > now) {
    return !cached.rules.some(
      (rule) => rule !== "" && robotsRuleToRegExp(rule).test(url.pathname + url.search),
    );
  }
  let txt = "";
  try {
    const response = await fetchFn(`${origin}/robots.txt`, {
      method: "GET",
      redirect: "manual",
      signal: signal ?? AbortSignal.timeout(5000),
      headers: { "User-Agent": EXTRACT_UA },
    });
    if (response.ok) {
      const type = (response.headers.get("content-type") ?? "").toLowerCase();
      if (type === "" || /text\/plain|text\/html/.test(type)) {
        const body = await response.text();
        txt = body.slice(0, 100_000);
      }
    }
    // 404/sem robots ⇒ permitido; 401/403 no robots ⇒ fail-open.
  } catch {
    // Rede falhou no robots ⇒ fail-open (padrão da indústria para crawlers).
  }
  const rules = parseRobotsForUs(txt);
  robotsCache.set(origin, { rules, expiresAt: now + ROBOTS_CACHE_TTL_MS });
  return !rules.some(
    (rule) => rule !== "" && robotsRuleToRegExp(rule).test(url.pathname + url.search),
  );
}

/** Só para testes. */
export function clearExtractRobotsCache(): void {
  robotsCache.clear();
}

// ---------------------------------------------------------------- cache ETag

type PageCacheEntry = {
  etag?: string;
  lastModified?: string;
  title?: string;
  markdown?: string;
  truncated?: boolean;
  expiresAt: number;
};

const pageCache = new Map<string, PageCacheEntry>();

/** Só para testes. */
export function clearExtractCache(): void {
  pageCache.clear();
}

// ---------------------------------------------------------------- fetch

function linkedSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

async function readCappedBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) {
    const buf = await response.arrayBuffer();
    return new Uint8Array(buf).subarray(0, maxBytes);
  }
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
  const merged = Buffer.concat(chunks);
  return new Uint8Array(merged.buffer, merged.byteOffset, Math.min(merged.byteLength, maxBytes));
}

/** GET seguindo redirects manualmente (cada salto repassa pelo guard SSRF). */
async function safeExtractFetch(
  rawUrl: string,
  options: ExtractWebPageOptions & { headers?: Record<string, string> },
): Promise<{ response: Response; finalUrl: string }> {
  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  const lookupFn = options.lookupFn ?? defaultLookup;
  const signal = linkedSignal(options.signal, options.timeoutMs ?? EXTRACT_TIMEOUT_MS);
  let current = rawUrl;
  for (let hop = 0; hop <= EXTRACT_MAX_REDIRECTS; hop += 1) {
    const url = await assertPublicExtractUrl(current, lookupFn);
    const response = await fetchFn(url.toString(), {
      method: "GET",
      redirect: "manual",
      signal,
      headers: {
        "User-Agent": EXTRACT_UA,
        Accept: "text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.5",
        "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
        ...options.headers,
      },
    });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      current = new URL(location, url).toString();
      continue;
    }
    return { response, finalUrl: url.toString() };
  }
  throw new ExtractError(
    "blocked",
    "redirecionamentos demais",
    `${BROWSER_HINT}, motivo: redirect loop`,
  );
}

// ---------------------------------------------------------------- HTML→Markdown

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});

const JS_SIGNALS =
  /<div id="(root|app|__next)"|__NEXT_DATA__|__NUXT__|ng-app|data-reactroot|enable javascript|habilite o javascript|requires javascript/i;

/** HTML → Markdown do conteúdo principal (Readability + Turndown). */
export function htmlToMarkdown(
  html: string,
  baseUrl?: string,
): { title?: string; markdown: string } {
  const { document } = parseHTML(html);
  // Base para URLs relativas (links/imagens) — best-effort.
  if (baseUrl) {
    try {
      const base = document.createElement("base");
      base.setAttribute("href", baseUrl);
      document.head?.appendChild(base);
    } catch {
      // Sem head — segue sem base.
    }
  }
  const reader = new Readability(document as unknown as Document, {
    charThreshold: 100,
  });
  const article = reader.parse();
  const title =
    article?.title?.trim() ||
    document.querySelector("title")?.textContent?.trim() ||
    undefined;
  const markdown = article?.content ? turndown.turndown(article.content).trim() : "";
  return { title: title || undefined, markdown };
}

// ---------------------------------------------------------------- extract

function truncateMarkdown(
  markdown: string,
  maxChars: number,
): { markdown: string; truncated: boolean } {
  if (markdown.length <= maxChars) return { markdown, truncated: false };
  return {
    markdown: `${markdown.slice(0, maxChars)}${EXTRACT_TRUNCATED_SUFFIX}`,
    truncated: true,
  };
}

/**
 * Extrai uma página (HTML→Markdown ou PDF→texto). Lança `ExtractError` com
 * `code` + `hint` — nunca texto cru. Página sem conteúdo útil vira
 * `needs_js` ("requer JS — use sandbox browser").
 */
export async function extractWebPage(
  rawUrl: string,
  options: ExtractWebPageOptions = {},
): Promise<ExtractedPage> {
  const fetchedAt = new Date().toISOString();
  const maxChars = Math.max(
    100,
    Math.min(200_000, Math.floor(options.maxChars ?? EXTRACT_DEFAULT_MAX_CHARS)),
  );
  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);

  let first: URL;
  try {
    first = await assertPublicExtractUrl(rawUrl, options.lookupFn);
  } catch (error) {
    if (error instanceof ExtractError) throw error;
    throw new ExtractError("blocked", "URL inválida", "corrija a URL ou use web_search");
  }

  // robots.txt antes de gastar a cota do domínio (fail-open em erro de rede).
  const allowed = await isAllowedByRobots(first, fetchFn, options.signal).catch(() => true);
  if (!allowed) {
    throw new ExtractError(
      "robots_denied",
      `robots.txt proíbe a extração: ${first.origin}${first.pathname}`,
      `${BROWSER_HINT}, motivo: robots.txt`,
    );
  }

  const cacheKey = first.toString();
  const cached = pageCache.get(cacheKey);
  if (cached?.markdown !== undefined && cached.expiresAt > Date.now()) {
    return {
      url: cacheKey,
      title: cached.title,
      markdown: cached.markdown,
      truncated: cached.truncated ?? false,
      fetchedAt,
      fromCache: true,
    };
  }

  checkExtractRateLimit(first.hostname.toLowerCase());

  let response: Response;
  let finalUrl: string;
  try {
    const headers: Record<string, string> = {};
    if (cached?.etag) headers["If-None-Match"] = cached.etag;
    if (cached?.lastModified) headers["If-Modified-Since"] = cached.lastModified;
    ({ response, finalUrl } = await safeExtractFetch(rawUrl, { ...options, headers }));
  } catch (error) {
    if (error instanceof ExtractError) throw error;
    const timedOut =
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    throw new ExtractError(
      timedOut ? "timeout" : "blocked",
      timedOut ? "tempo esgotado na extração" : error instanceof Error ? error.message.slice(0, 200) : "falha de rede",
      `${BROWSER_HINT}, motivo: ${timedOut ? "timeout" : "falha de rede"}`,
    );
  }

  if (response.status === 304 && cached?.markdown !== undefined) {
    cached.expiresAt = Date.now() + EXTRACT_CACHE_TTL_MS;
    return {
      url: finalUrl,
      title: cached.title,
      markdown: cached.markdown,
      truncated: cached.truncated ?? false,
      fetchedAt,
      fromCache: true,
    };
  }
  if (response.status === 401 || response.status === 403) {
    throw new ExtractError(
      "needs_login",
      `HTTP ${response.status} (acesso negado/login)`,
      `${BROWSER_HINT}, motivo: acesso negado/login`,
    );
  }
  if (response.status === 429) {
    throw new ExtractError(
      "rate_limited",
      "HTTP 429 (limite do site)",
      `${BROWSER_HINT}, motivo: rate limit`,
    );
  }
  if (!response.ok) {
    throw new ExtractError(
      "blocked",
      `HTTP ${response.status}`,
      `${BROWSER_HINT}, motivo: HTTP ${response.status}`,
    );
  }

  const type = (response.headers.get("content-type") ?? "").toLowerCase();
  const etag = response.headers.get("etag") ?? undefined;
  const lastModified = response.headers.get("last-modified") ?? undefined;

  const store = (title: string | undefined, markdown: string, truncated: boolean) => {
    pageCache.set(cacheKey, {
      etag,
      lastModified,
      title,
      markdown,
      truncated,
      expiresAt: Date.now() + EXTRACT_CACHE_TTL_MS,
    });
  };

  // PDF — texto via pdf-parse (falha ⇒ blocked, não crash).
  if (type.includes("pdf") || /\.pdf(\?|#|$)/i.test(finalUrl)) {
    const bytes = await readCappedBytes(response, EXTRACT_MAX_BYTES);
    let text = "";
    try {
      const data = await pdfParse(Buffer.from(bytes));
      text = (data.text ?? "").trim();
    } catch {
      throw new ExtractError(
        "blocked",
        "PDF sem texto legível",
        `${BROWSER_HINT}, motivo: PDF não extraível`,
      );
    }
    if (text.length < 20) {
      throw new ExtractError(
        "empty",
        "PDF sem texto legível (provável scan/imagem)",
        `${BROWSER_HINT}, motivo: PDF sem texto`,
      );
    }
    const capped = truncateMarkdown(text, maxChars);
    store(undefined, capped.markdown, capped.truncated);
    return { url: finalUrl, fetchedAt, markdown: capped.markdown, truncated: capped.truncated };
  }

  const isTextual =
    !type ||
    /text\/|html|xml|json|rss|atom/.test(type);
  if (!isTextual) {
    throw new ExtractError(
      "blocked",
      `conteúdo não textual (${type.split(";")[0] || "desconhecido"})`,
      `${BROWSER_HINT}, motivo: arquivo binário`,
    );
  }

  const bytes = await readCappedBytes(response, EXTRACT_MAX_BYTES);
  const raw = new TextDecoder("utf-8").decode(bytes);
  const looksHtml = type.includes("html") || /<html[\s>]/i.test(raw.slice(0, 2000));

  // Texto cru (txt/json/xml/rss) — sem Readability.
  if (!looksHtml) {
    const text = raw.trim();
    if (text.length < EXTRACT_MIN_TEXT_CHARS) {
      throw new ExtractError(
        "empty",
        "página sem texto legível",
        "tente web_search com outra query",
      );
    }
    const capped = truncateMarkdown(text, maxChars);
    store(undefined, capped.markdown, capped.truncated);
    return { url: finalUrl, fetchedAt, markdown: capped.markdown, truncated: capped.truncated };
  }

  const { title, markdown } = htmlToMarkdown(raw, finalUrl);
  if (markdown.length < EXTRACT_MIN_TEXT_CHARS) {
    if (JS_SIGNALS.test(raw)) {
      throw new ExtractError("needs_js", NEEDS_JS_MESSAGE, `${BROWSER_HINT}, motivo: página renderizada por JS`);
    }
    throw new ExtractError(
      "empty",
      "página sem texto legível (provável JS ou login)",
      `${BROWSER_HINT}, motivo: página renderizada por JS`,
    );
  }
  const capped = truncateMarkdown(markdown, maxChars);
  store(title, capped.markdown, capped.truncated);
  return {
    url: finalUrl,
    title,
    fetchedAt,
    markdown: capped.markdown,
    truncated: capped.truncated,
  };
}
