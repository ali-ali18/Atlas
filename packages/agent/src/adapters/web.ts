// Adaptador real da porta `Search` (F2.1). Recebe a busca (SearXNG) e a extração (`extractWebPage`) de
// `@workspace/search` por INJEÇÃO, com a forma estrutural abaixo: o worker passa as funções reais e este pacote
// não ganha dependência pesada (Readability, pdf-parse). O que o adaptador acrescenta:
//  - busca: SearXNG primeiro; se não houver ou falhar, DuckDuckGo direto (parser puro em `@workspace/shared`);
//  - extração: SSRF barrado de novo aqui (defesa em profundidade; o DNS e os redirecionamentos são do `extractWebPage`),
//    a PÁGINA VOLTA INTEIRA (o teto de caracteres é o limite técnico da lib, não economia) e erro da lib vira mensagem
//    em inglês, sem nome de tool do v2 e sem texto de terceiro cru;
//  - timeout e tamanho técnicos, nunca de economia.
import { duckDuckGoParams, parseDuckDuckGoHtml } from "@workspace/shared";
import { checkPublicHttpUrl } from "../presets/web-url.js";
import type { Search, SearchExtract, SearchHit } from "../ports/search.js";

/** Forma mínima de `searchSearxng` (o `baseUrl` já vem preso pelo worker). */
export type SearxngSearchFn = (query: string, options: { num?: number; signal?: AbortSignal }) => Promise<ReadonlyArray<{ url: string; title: string; snippet: string }>>;

/** Forma mínima de `extractWebPage`. */
export type ExtractPageFn = (url: string, options: { signal?: AbortSignal; timeoutMs?: number; maxChars?: number }) => Promise<{ url: string; title?: string; markdown: string; truncated: boolean }>;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type WebAdapterDeps = {
	extract: ExtractPageFn;
	/** Sem SearXNG configurado, a busca vai direto ao DuckDuckGo. */
	searxng?: SearxngSearchFn;
	fetchFn?: FetchLike;
	/** Idioma do run (`pt-BR`, `en-US`…): vai em `kl` e em `Accept-Language`. Sem ele, `Accept-Language` neutro (`en`). */
	locale?: string;
};

/** Teto técnico de caracteres do Markdown da lib de extração (`extractWebPage` limita a 200 mil). Não é economia. */
export const EXTRACT_TECHNICAL_MAX_CHARS = 200_000;
export const EXTRACT_TIMEOUT_MS = 30_000;
export const SEARCH_FETCH_TIMEOUT_MS = 15_000;
/** Limite técnico da página HTML de resultados do DuckDuckGo. */
export const SEARCH_MAX_HTML_BYTES = 2_000_000;
const DDG_HTML_URL = "https://html.duckduckgo.com/html/";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const LOCALE_FORMAT = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/;

/** `Accept-Language` derivado do idioma do run; formato inválido ou ausente cai em `en` (nunca um idioma do dono fixo). */
export function acceptLanguageFor(locale?: string): string {
	const tag = locale?.trim();
	if (!tag || !LOCALE_FORMAT.test(tag)) return "en";
	const base = tag.split("-")[0] as string;
	return tag === base ? `${tag},en;q=0.8` : `${tag},${base};q=0.9,en;q=0.8`;
}

const EXTRACT_ERROR_TEXT: Readonly<Record<string, string>> = {
	blocked: "The page could not be fetched (blocked, not found or unreachable).",
	needs_login: "The page needs a login or denied access.",
	empty: "The page has no readable content.",
	timeout: "The page took too long to answer.",
	needs_js: "The page only renders with JavaScript, so there is no text to read here.",
	robots_denied: "The site does not allow automated reading of this page.",
	rate_limited: "The site is limiting requests; try again later.",
};

function errorCode(error: unknown): string | undefined {
	if (typeof error === "object" && error !== null && "code" in error && typeof (error as { code: unknown }).code === "string") return (error as { code: string }).code;
	return undefined;
}

function isTimeout(error: unknown): boolean {
	return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
	if (!response.body) return (await response.text()).slice(0, maxBytes);
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

async function searchDuckDuckGo(query: string, limit: number, deps: WebAdapterDeps, signal?: AbortSignal): Promise<SearchHit[]> {
	const fetchFn = deps.fetchFn ?? ((input, init) => globalThis.fetch(input, init));
	const timeout = AbortSignal.timeout(SEARCH_FETCH_TIMEOUT_MS);
	const response = await fetchFn(`${DDG_HTML_URL}?${duckDuckGoParams(query, { locale: deps.locale }).toString()}`, {
		method: "GET",
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		headers: { "User-Agent": USER_AGENT, "Accept-Language": acceptLanguageFor(deps.locale) },
	});
	if (response.status === 202 || response.status === 403 || response.status === 429) throw new Error(`The search engine is limiting requests (HTTP ${response.status}).`);
	if (!response.ok) throw new Error(`The search engine failed (HTTP ${response.status}).`);
	const html = await readCapped(response, SEARCH_MAX_HTML_BYTES);
	// guard-allow: format-validation marcador fixo da página de verificação do provedor, não texto do dono nem do modelo
	if (html.includes("anomaly-modal")) throw new Error("The search engine asked for a human check.");
	return parseDuckDuckGoHtml(html, limit).map(({ title, url, snippet }) => ({ title, url, snippet }));
}

export function createWebAdapter(deps: WebAdapterDeps): Search {
	return {
		async search(_userId, query, options, signal) {
			const limit = Math.max(1, Math.min(20, Math.floor(options?.limit ?? 5)));
			let primaryError: unknown;
			if (deps.searxng) {
				try {
					const hits = await deps.searxng(query, { num: limit, ...(signal && { signal }) });
					if (hits.length > 0) return hits.slice(0, limit).map(({ title, url, snippet }) => ({ title, url, snippet }));
				} catch (error) {
					if (signal?.aborted) throw error;
					primaryError = error;
				}
			}
			try {
				return await searchDuckDuckGo(query, limit, deps, signal);
			} catch (error) {
				if (signal?.aborted) throw error;
				const reason = isTimeout(error) ? "The search timed out." : error instanceof Error ? error.message : "The search failed.";
				throw new Error(`Web search is unavailable right now. ${reason}${primaryError ? " The main search service also failed." : ""} Try again later or answer without fresh web results.`);
			}
		},
		async extract(_userId, url, signal): Promise<SearchExtract> {
			// Defesa em profundidade: a tool já valida, mas a porta pode ser chamada por outra capacidade.
			const checked = checkPublicHttpUrl(url);
			if (!checked.ok) throw new Error(`${checked.reason}; give a public http(s) page URL.`);
			try {
				const page = await deps.extract(url, { ...(signal && { signal }), timeoutMs: EXTRACT_TIMEOUT_MS, maxChars: EXTRACT_TECHNICAL_MAX_CHARS });
				const note = page.truncated ? `\n\n[The page is longer than the technical reading limit (${EXTRACT_TECHNICAL_MAX_CHARS} characters); the rest could not be read.]` : "";
				return { url: page.url, ...(page.title && { title: page.title }), text: `${page.markdown}${note}` };
			} catch (error) {
				if (signal?.aborted) throw error;
				const code = isTimeout(error) ? "timeout" : errorCode(error);
				throw new Error(EXTRACT_ERROR_TEXT[code ?? "blocked"] ?? EXTRACT_ERROR_TEXT.blocked!);
			}
		},
	};
}
