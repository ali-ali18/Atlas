/**
 * Atlas Search S1 — cliente do SearXNG auto-hospedado.
 *
 * O SearXNG roda no `docker-compose.yml` (serviço `searxng`, só rede
 * interna, sem `ports:`) e agrega buscadores públicos sem chave. Este
 * cliente adiciona em cima da JSON API (`/search?format=json`):
 * - timeout por tentativa (+ `timeout_limit` best-effort no servidor);
 * - retry com backoff exponencial;
 * - circuit breaker em memória por engine/categoria (engine que falha sai
 *   da rotação por N min via parâmetro `engines`);
 * - dedupe por URL canônica.
 *
 * Escopo reduzido (sem índice): S3 fará o índice Postgres
 * (WebPage/WebChunk, busca híbrida, ranking RRF); S4 fará extração
 * estruturada via LLM, vigias e eval. Nada disso aqui.
 */

export type SearxngResult = {
  url: string;
  title: string;
  snippet: string;
  engine?: string;
  category?: string;
};

export type SearxngSearchErrorCode = "blocked" | "empty" | "timeout";

export class SearxngSearchError extends Error {
  readonly code: SearxngSearchErrorCode;
  readonly hint: string;

  constructor(code: SearxngSearchErrorCode, message: string, hint: string) {
    super(message);
    this.name = "SearxngSearchError";
    this.code = code;
    this.hint = hint;
  }
}

export const SEARXNG_DEFAULT_TIMEOUT_MS = 8_000;
export const SEARXNG_DEFAULT_RETRIES = 2;
export const SEARXNG_RETRY_BASE_MS = 250;
/** Engine/categoria que falha sai da rotação por 5 min. */
export const SEARXNG_CIRCUIT_BREAK_MS = 5 * 60_000;
export const SEARXNG_CIRCUIT_MAX_FAILURES = 3;
export const SEARXNG_DEFAULT_CATEGORY = "general";
export const SEARXNG_DEFAULT_ENGINES = [
  "duckduckgo",
  "bing",
  "mojeek",
  "qwant",
  "wikipedia",
  "github",
  "stackoverflow",
];

export type SearxngFetchFn = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/** URL base do SearXNG (ex.: `http://searxng:8080` na rede do compose). */
export function resolveSearxngBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw = (env.SEARXNG_BASE_URL ?? "").trim().replace(/\/+$/, "");
  return raw ? raw : undefined;
}

/** SearXNG configurado? Sem ele, o chamador usa o fallback (DDG direto). */
export function isSearchAvailable(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return resolveSearxngBaseUrl(env) !== undefined;
}

// ---------------------------------------------------------- circuit breaker

type BreakerState = { failures: number; blockedUntil: number };

const breakers = new Map<string, BreakerState>();

export function searxngBreakerKey(
  kind: "engine" | "category" | "server",
  name: string,
): string {
  return `${kind}:${name.trim().toLowerCase()}`;
}

export function isSearxngCircuitOpen(
  key: string,
  now = Date.now(),
): boolean {
  const state = breakers.get(key);
  return state !== undefined && state.blockedUntil > now;
}

/** Engines ainda fora da rotação (para diagnóstico/métricas — S4). */
export function getDisabledSearxngEngines(now = Date.now()): string[] {
  const out: string[] = [];
  for (const [key, state] of breakers) {
    if (key.startsWith("engine:") && state.blockedUntil > now) {
      out.push(key.slice("engine:".length));
    }
  }
  return out;
}

export function recordSearxngSuccess(key: string): void {
  breakers.delete(key);
}

export function recordSearxngFailure(
  key: string,
  breakMs = SEARXNG_CIRCUIT_BREAK_MS,
  now = Date.now(),
): void {
  const state = breakers.get(key) ?? { failures: 0, blockedUntil: 0 };
  state.failures += 1;
  if (state.failures >= SEARXNG_CIRCUIT_MAX_FAILURES) {
    state.blockedUntil = now + breakMs;
  }
  breakers.set(key, state);
}

/** Só para testes — limpa o estado do circuit breaker. */
export function clearSearxngCircuitBreakers(): void {
  breakers.clear();
}

// ---------------------------------------------------------- URL canônica

const TRACKING_PARAMS: RegExp[] = [
  /^utm_/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^msclkid$/i,
  /^yclid$/i,
  /^mc_[a-z]+$/i,
  /^igshid$/i,
];

/** Normaliza para dedupe: host minúsculo, sem hash, sem tracking, sem `/` final. */
export function canonicalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  try {
    const url = new URL(trimmed);
    url.hostname = url.hostname.toLowerCase();
    if (
      (url.protocol === "http:" && url.port === "80") ||
      (url.protocol === "https:" && url.port === "443")
    ) {
      url.port = "";
    }
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.some((pattern) => pattern.test(key))) {
        url.searchParams.delete(key);
      }
    }
    let out = url.toString();
    if (url.search === "" && out.endsWith("/") && url.pathname === "/") {
      out = out.slice(0, -1);
    } else if (out.length > 1 && out.endsWith("/")) {
      out = out.slice(0, -1);
    }
    return out;
  } catch {
    return trimmed;
  }
}

/** Dedupe preservando a ordem (primeira ocorrência vence). */
export function dedupeSearxngResults<T extends { url: string }>(
  items: T[],
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = canonicalizeUrl(item.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

// ---------------------------------------------------------- resposta

function cleanSnippet(value: unknown, max = 500): string {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Converte o JSON do SearXNG (`/search?format=json`) — pura, testável. */
export function parseSearxngResponse(json: unknown): SearxngResult[] {
  if (!isRecord(json)) return [];
  const raw = Array.isArray(json.results) ? json.results : [];
  const out: SearxngResult[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const url = String(item.url ?? "").trim();
    if (!/^https?:\/\//i.test(url)) continue;
    out.push({
      url,
      title: String(item.title ?? url).trim() || url,
      snippet: cleanSnippet(item.content ?? ""),
      engine: typeof item.engine === "string" ? item.engine : undefined,
      category:
        typeof item.category === "string" ? item.category : undefined,
    });
  }
  return dedupeSearxngResults(out);
}

// ---------------------------------------------------------- busca

export type SearxngSearchOptions = {
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
  /** Categoria do SearXNG (padrão `general`). */
  categories?: string;
  /** Engines preferidas; as com circuito aberto saem da rotação. */
  engines?: string[];
  /** Idioma (`language` do SearXNG, padrão `pt-BR`). */
  language?: string;
  /** Recência best-effort (`time_range` do SearXNG: day|week|month|year). */
  timeRange?: string;
  /** 1-20, padrão 8. */
  num?: number;
  /** Timeout por tentativa (ms). */
  timeoutMs?: number;
  maxRetries?: number;
  safesearch?: 0 | 1 | 2;
  signal?: AbortSignal;
  fetchFn?: SearxngFetchFn;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function linkedSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

/**
 * Busca via SearXNG com retry + circuit breaker. Erros são `SearxngSearchError`
 * (`blocked`/`empty`/`timeout`) — o chamador decide o fallback (DDG direto).
 */
export async function searchSearxng(
  query: string,
  options: SearxngSearchOptions = {},
): Promise<SearxngResult[]> {
  const trimmed = query.trim();
  if (!trimmed) {
    throw new SearxngSearchError("empty", "query vazia", "informe o que buscar");
  }
  const baseUrl = (
    options.baseUrl ??
    resolveSearxngBaseUrl(options.env ?? process.env) ??
    ""
  ).replace(/\/+$/, "");
  if (!baseUrl) {
    throw new SearxngSearchError(
      "blocked",
      "SearXNG indisponível: SEARXNG_BASE_URL não configurado",
      "configure SEARXNG_BASE_URL ou use o fallback (DuckDuckGo direto)",
    );
  }
  const num = Math.max(
    1,
    Math.min(20, Math.floor(options.num ?? 8)),
  );
  const categories = (options.categories ?? SEARXNG_DEFAULT_CATEGORY).trim() || SEARXNG_DEFAULT_CATEGORY;
  const wanted = options.engines ?? SEARXNG_DEFAULT_ENGINES;
  const enabled = wanted.filter(
    (engine) => !isSearxngCircuitOpen(searxngBreakerKey("engine", engine)),
  );
  const timeoutMs = options.timeoutMs ?? SEARXNG_DEFAULT_TIMEOUT_MS;
  const maxRetries = Math.max(
    0,
    Math.floor(options.maxRetries ?? SEARXNG_DEFAULT_RETRIES),
  );

  const params = new URLSearchParams({
    q: trimmed,
    format: "json",
    categories,
    language: (options.language ?? "pt-BR").trim() || "pt-BR",
    safesearch: String(options.safesearch ?? 1),
    // Best-effort: o SearXNG repassa como teto por engine.
    timeout_limit: String(Math.max(1, timeoutMs / 1000)),
  });
  const timeRange = (options.timeRange ?? "").trim().toLowerCase();
  if (["day", "week", "month", "year"].includes(timeRange)) {
    params.set("time_range", timeRange);
  }
  // Fail-open: se todas as engines estão com circuito aberto, omite o filtro
  // e deixa o servidor decidir (em vez de falhar sem tentar).
  if (enabled.length > 0 && enabled.length < wanted.length) {
    params.set("engines", enabled.join(","));
  } else if (enabled.length === wanted.length && options.engines) {
    params.set("engines", enabled.join(","));
  }

  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  const categoryKey = searxngBreakerKey("category", categories);
  const serverKey = searxngBreakerKey("server", baseUrl);
  let lastError: SearxngSearchError | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await fetchFn(`${baseUrl}/search?${params.toString()}`, {
        method: "GET",
        signal: linkedSignal(options.signal, timeoutMs),
        headers: { Accept: "application/json" },
      });
      if (response.status === 429) {
        throw new SearxngSearchError(
          "blocked",
          "SearXNG com rate limit (HTTP 429)",
          "aguarde ou use o fallback (DuckDuckGo direto)",
        );
      }
      if (!response.ok) {
        throw new SearxngSearchError(
          "blocked",
          `SearXNG falhou (HTTP ${response.status})`,
          "tente de novo ou use o fallback (DuckDuckGo direto)",
        );
      }
      let json: unknown;
      try {
        json = await response.json();
      } catch {
        throw new SearxngSearchError(
          "blocked",
          "resposta inválida do SearXNG",
          "tente de novo ou use o fallback (DuckDuckGo direto)",
        );
      }
      const results = parseSearxngResponse(json).slice(0, num);
      if (results.length === 0) {
        throw new SearxngSearchError(
          "empty",
          "SearXNG sem resultados",
          "tente outra query ou o fallback (DuckDuckGo direto)",
        );
      }
      recordSearxngSuccess(categoryKey);
      recordSearxngSuccess(serverKey);
      for (const result of results) {
        if (result.engine) {
          recordSearxngSuccess(searxngBreakerKey("engine", result.engine));
        }
      }
      return results;
    } catch (error) {
      if (error instanceof SearxngSearchError && error.code === "empty") {
        throw error; // vazio genuíno — retry não ajuda
      }
      const timedOut =
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError");
      lastError =
        error instanceof SearxngSearchError
          ? error
          : new SearxngSearchError(
              timedOut ? "timeout" : "blocked",
              timedOut
                ? `SearXNG excedeu ${timeoutMs}ms`
                : error instanceof Error
                  ? `SearXNG: ${error.message.slice(0, 200)}`
                  : "SearXNG: falha de rede",
              "tente de novo ou use o fallback (DuckDuckGo direto)",
            );
      if (attempt < maxRetries) {
        await sleep(SEARXNG_RETRY_BASE_MS * 2 ** attempt);
        continue;
      }
      recordSearxngFailure(categoryKey);
      recordSearxngFailure(serverKey);
      throw lastError;
    }
  }
  // Inalcançável (o loop sempre retorna ou lança), mas agrada o TS.
  throw (
    lastError ??
    new SearxngSearchError("blocked", "SearXNG falhou", "use o fallback")
  );
}
