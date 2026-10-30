/**
 * Atlas Search — busca própria, sem providers pagos (AUTH_PLAN.md §5).
 *
 * - S1 (este pacote): cliente SearXNG (`searxng.ts`) com retry/circuit
 *   breaker/dedupe; `isSearchAvailable()` diz se há SearXNG configurado.
 * - S2 (este pacote): extração própria (`extract.ts`: Readability/Markdown/
 *   PDF, robots, rate-limit, cache ETag em memória).
 * - S3/S4 (FORA do escopo): índice Postgres (WebPage/WebChunk), busca
 *   híbrida + RRF, extração estruturada via LLM, vigias, eval.
 */

export {
  SEARXNG_CIRCUIT_BREAK_MS,
  SEARXNG_CIRCUIT_MAX_FAILURES,
  SEARXNG_DEFAULT_CATEGORY,
  SEARXNG_DEFAULT_ENGINES,
  SEARXNG_DEFAULT_RETRIES,
  SEARXNG_DEFAULT_TIMEOUT_MS,
  SEARXNG_RETRY_BASE_MS,
  SearxngSearchError,
  canonicalizeUrl,
  clearSearxngCircuitBreakers,
  dedupeSearxngResults,
  getDisabledSearxngEngines,
  isSearchAvailable,
  isSearxngCircuitOpen,
  parseSearxngResponse,
  recordSearxngFailure,
  recordSearxngSuccess,
  resolveSearxngBaseUrl,
  searchSearxng,
  searxngBreakerKey,
} from "./searxng.js";
export type {
  SearxngFetchFn,
  SearxngResult,
  SearxngSearchErrorCode,
  SearxngSearchOptions,
} from "./searxng.js";

export {
  EXTRACT_CACHE_TTL_MS,
  EXTRACT_DEFAULT_MAX_CHARS,
  EXTRACT_MAX_BYTES,
  EXTRACT_MAX_REDIRECTS,
  EXTRACT_MIN_TEXT_CHARS,
  EXTRACT_RATE_MAX,
  EXTRACT_RATE_WINDOW_MS,
  EXTRACT_TIMEOUT_MS,
  EXTRACT_TRUNCATED_SUFFIX,
  EXTRACT_UA,
  NEEDS_JS_MESSAGE,
  ROBOTS_CACHE_TTL_MS,
  ExtractError,
  assertPublicExtractUrl,
  clearExtractCache,
  clearExtractRateLimits,
  clearExtractRobotsCache,
  extractWebPage,
  htmlToMarkdown,
  isAllowedByRobots,
  isPrivateExtractAddress,
} from "./extract.js";
export type {
  ExtractErrorCode,
  ExtractFetchFn,
  ExtractLookupFn,
  ExtractWebPageOptions,
  ExtractedPage,
} from "./extract.js";

export {
  ALERT_SOURCE_CACHE_TTL_MS,
  ALERT_SOURCE_MAX_BYTES,
  ALERT_SOURCE_MAX_REDIRECTS,
  ALERT_SOURCE_TIMEOUT_MS,
  ALERT_SOURCE_UA,
  createAlertSourceCache,
  readAlertRule,
  readAlertSource,
} from "./alert-source.js";
export type {
  AlertSourceCache,
  AlertSourceDeps,
  AlertSourceFailure,
  AlertSourceResult,
} from "./alert-source.js";
