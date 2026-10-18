/**
 * Parte B — `web_search`: busca web via provedor plugável (HTTP API).
 *
 * Bloco NOVO, sem wiring no `computer-use.ts` (o integrador fará):
 * - o integrador expõe a tool só quando `isWebSearchAvailable()` for true;
 * - idempotência/contagem usam o checkpoint existente (`toolCallCounts` +
 *   step records via `onStep` em `computer-use.ts`) — nada em memória fora
 *   do run. Não criar store novo.
 *
 * Sem chave (`SEARCH_API_KEY`/`FIRECRAWL_API_KEY`) a tool deve ficar oculta
 * e o fallback é o navegador (`navigate` + `browser_text`).
 */

export type SearchProvider = "firecrawl" | "tavily" | "brave" | "serper";

export type WebSearchArgs = {
	query: string;
	/** 1-10, padrão 8. */
	num?: number;
	/** Padrão "pt-BR". */
	locale?: string;
	/** Recência best-effort (ex.: "day" | "week" | "month" | "year"). Nem todo provedor suporta. */
	recency?: string;
};

export type WebSearchResult = {
	url: string;
	title: string;
	snippet: string;
	source: string;
};

export type WebSearchErrorCode = "blocked" | "needs_login" | "empty" | "timeout";

export class WebSearchError extends Error {
	readonly code: WebSearchErrorCode;
	readonly escalateHint: string;

	constructor(code: WebSearchErrorCode, message: string, escalateHint: string) {
		super(message);
		this.name = "WebSearchError";
		this.code = code;
		this.escalateHint = escalateHint;
	}
}

/** Fetch mínimo estrutural (aceita o fetch global e mocks de teste). */
export type SearchFetchFn = (
	input: string,
	init?: RequestInit,
) => Promise<{
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
	text(): Promise<string>;
}>;

export const WEB_SEARCH_TIMEOUT_MS = 15_000;
export const WEB_SEARCH_DEFAULT_NUM = 8;
export const WEB_SEARCH_DEFAULT_LOCALE = "pt-BR";

const SEARCH_PROVIDERS: SearchProvider[] = [
	"firecrawl",
	"tavily",
	"brave",
	"serper",
];

/** Normaliza o provedor vindo de `SEARCH_PROVIDER`; desconhecido => "firecrawl". */
export function resolveSearchProvider(raw: string | undefined): SearchProvider {
	const normalized = (raw ?? "").trim().toLowerCase();
	return (SEARCH_PROVIDERS as string[]).includes(normalized)
		? (normalized as SearchProvider)
		: "firecrawl";
}

/** Lê a chave de busca: `SEARCH_API_KEY` tem precedência sobre `FIRECRAWL_API_KEY`. */
export function resolveSearchApiKey(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const key = (
		env.SEARCH_API_KEY?.trim() ||
		env.FIRECRAWL_API_KEY?.trim() ||
		""
	);
	return key ? key : undefined;
}

/** Sem chave a tool deve ficar oculta (o integrador esconde) — fallback: navegador. */
export function isWebSearchAvailable(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return resolveSearchApiKey(env) !== undefined;
}

export type NormalizedSearchArgs = {
	query: string;
	num: number;
	locale: string;
	recency?: string;
};

export function normalizeSearchArgs(args: WebSearchArgs): NormalizedSearchArgs {
	const query = (args.query ?? "").trim();
	const rawNum = Number(args.num ?? WEB_SEARCH_DEFAULT_NUM);
	const num = Number.isFinite(rawNum)
		? Math.max(1, Math.min(10, Math.floor(rawNum)))
		: WEB_SEARCH_DEFAULT_NUM;
	const locale = (args.locale ?? "").trim() || WEB_SEARCH_DEFAULT_LOCALE;
	const recency = (args.recency ?? "").trim() || undefined;
	return { query, num, locale, recency };
}

export type BuiltSearchRequest = {
	url: string;
	method: "GET" | "POST";
	headers: Record<string, string>;
	body?: string;
};

/**
 * Monta a requisição HTTP do provedor (pura: sem leitura de env, sem I/O).
 * A chave entra via parâmetro — o caller resolve com `resolveSearchApiKey()`.
 */
export function buildSearchRequest(
	provider: SearchProvider,
	args: WebSearchArgs,
	apiKey: string,
): BuiltSearchRequest {
	const normalized = normalizeSearchArgs(args);
	if (provider === "firecrawl") {
		const body: Record<string, unknown> = {
			query: normalized.query,
			limit: normalized.num,
			lang: normalized.locale,
		};
		return {
			url: "https://api.firecrawl.dev/v1/search",
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify(body),
		};
	}
	if (provider === "tavily") {
		const body: Record<string, unknown> = {
			api_key: apiKey,
			query: normalized.query,
			max_results: normalized.num,
			search_depth: "basic",
			include_answer: false,
		};
		if (
			normalized.recency &&
			["day", "week", "month", "year"].includes(normalized.recency)
		) {
			body.time_range = normalized.recency;
		}
		return {
			url: "https://api.tavily.com/search",
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		};
	}
	if (provider === "brave") {
		const params = new URLSearchParams({
			q: normalized.query,
			count: String(normalized.num),
		});
		const localeLower = normalized.locale.toLowerCase();
		if (localeLower === "pt-br") {
			params.set("country", "BR");
			params.set("search_lang", "pt-br");
		}
		return {
			url: `https://api.search.brave.com/res/v1/web/search?${params.toString()}`,
			method: "GET",
			headers: {
				Accept: "application/json",
				"X-Subscription-Token": apiKey,
			},
		};
	}
	// serper
	const body: Record<string, unknown> = {
		q: normalized.query,
		num: normalized.num,
	};
	if (normalized.locale.toLowerCase() === "pt-br") {
		body.gl = "br";
		body.hl = "pt-br";
	}
	return {
		url: "https://google.serper.dev/search",
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-API-KEY": apiKey,
		},
		body: JSON.stringify(body),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function cleanSnippet(value: unknown, max = 500): string {
	const text = String(value ?? "")
		.replace(/\s+/g, " ")
		.trim();
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Converte o JSON bruto de cada provedor para resultados normalizados (pura).
 * Formato desconhecido => lista vazia (o executor vira erro `empty`).
 */
export function parseSearchResponse(
	provider: SearchProvider,
	json: unknown,
): WebSearchResult[] {
	if (!isRecord(json)) return [];
	const out: WebSearchResult[] = [];
	if (provider === "firecrawl") {
		for (const item of asArray(json.data)) {
			if (!isRecord(item)) continue;
			const url = String(item.url ?? "").trim();
			if (!url) continue;
			out.push({
				url,
				title: String(item.title ?? url).trim() || url,
				snippet: cleanSnippet(
					item.description ?? item.snippet ?? item.markdown ?? "",
				),
				source: "firecrawl",
			});
		}
		return out;
	}
	if (provider === "tavily") {
		for (const item of asArray(json.results)) {
			if (!isRecord(item)) continue;
			const url = String(item.url ?? "").trim();
			if (!url) continue;
			out.push({
				url,
				title: String(item.title ?? url).trim() || url,
				snippet: cleanSnippet(item.content ?? item.snippet ?? ""),
				source: "tavily",
			});
		}
		return out;
	}
	if (provider === "brave") {
		const web = isRecord(json.web) ? json.web : {};
		for (const item of asArray((web as Record<string, unknown>).results)) {
			if (!isRecord(item)) continue;
			const url = String(item.url ?? "").trim();
			if (!url) continue;
			out.push({
				url,
				title: String(item.title ?? url).trim() || url,
				snippet: cleanSnippet(item.description ?? item.snippet ?? ""),
				source: "brave",
			});
		}
		return out;
	}
	// serper
	for (const item of asArray(json.organic)) {
		if (!isRecord(item)) continue;
		const url = String(item.link ?? item.url ?? "").trim();
		if (!url) continue;
		out.push({
			url,
			title: String(item.title ?? url).trim() || url,
			snippet: cleanSnippet(item.snippet ?? ""),
			source: "serper",
		});
	}
	return out;
}

export type ExecuteWebSearchOptions = {
	provider?: SearchProvider;
	apiKey?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	env?: NodeJS.ProcessEnv;
};

function classifySearchHttpStatus(
	status: number,
	bodyText: string,
): { code: WebSearchErrorCode; hint: string } {
	const lower = bodyText.toLowerCase();
	if (
		status === 401 ||
		status === 403 ||
		/login required|unauthorized|invalid api key|forbidden/.test(lower)
	) {
		return {
			code: "needs_login",
			hint: "verifique SEARCH_API_KEY/FIRECRAWL_API_KEY; se persistir, escale para navegador (navigate + browser_text)",
		};
	}
	if (status === 429) {
		return {
			code: "blocked",
			hint: "rate limit do provedor de busca; aguarde ou escale para navegador (navigate + browser_text)",
		};
	}
	return {
		code: "blocked",
		hint: "busca bloqueada/falhou; tente web_search com outra query ou escale para navegador (navigate + browser_text)",
	};
}

/**
 * Executa a busca com timeout (padrão 15s). Erros são estruturados
 * (`WebSearchError` com `code` + `escalateHint`), nunca texto cru.
 */
export async function executeWebSearch(
	args: WebSearchArgs,
	fetchFn?: SearchFetchFn,
	options: ExecuteWebSearchOptions = {},
): Promise<WebSearchResult[]> {
	const normalized = normalizeSearchArgs(args);
	if (!normalized.query) {
		throw new WebSearchError(
			"empty",
			"query vazia",
			"tente web_search com uma query não vazia",
		);
	}
	const env = options.env ?? process.env;
	const provider = options.provider ?? resolveSearchProvider(env.SEARCH_PROVIDER);
	const apiKey = options.apiKey ?? resolveSearchApiKey(env);
	if (!apiKey) {
		throw new WebSearchError(
			"blocked",
			"busca indisponível: SEARCH_API_KEY/FIRECRAWL_API_KEY ausente",
			"sem chave, a tool web_search fica oculta; fallback: navegador (navigate + browser_text)",
		);
	}
	const request = buildSearchRequest(
		provider,
		normalized,
		apiKey,
	);
	const timeoutMs = options.timeoutMs ?? WEB_SEARCH_TIMEOUT_MS;
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	if (options.signal) {
		if (options.signal.aborted) controller.abort();
		else {
			options.signal.addEventListener("abort", () => controller.abort(), {
				once: true,
			});
		}
	}
	const doFetch: SearchFetchFn | undefined =
		fetchFn ?? (globalThis.fetch as unknown as SearchFetchFn | undefined);
	if (!doFetch) {
		clearTimeout(timer);
		throw new WebSearchError(
			"blocked",
			"fetch indisponível neste ambiente",
			"escale para navegador (navigate + browser_text)",
		);
	}
	try {
		let response: Awaited<ReturnType<SearchFetchFn>>;
		try {
			response = await doFetch(request.url, {
				method: request.method,
				headers: request.headers,
				body: request.body,
				signal: controller.signal,
			});
		} catch (error) {
			if (
				timedOut ||
				(error instanceof Error &&
					(error.name === "TimeoutError" || error.name === "AbortError"))
			) {
				throw new WebSearchError(
					"timeout",
					`busca excedeu ${timeoutMs}ms`,
					"tente web_search com outra query ou escale para navegador (navigate + browser_text)",
				);
			}
			throw new WebSearchError(
				"blocked",
				error instanceof Error ? error.message : "falha de rede na busca",
				"tente web_search com outra query ou escale para navegador (navigate + browser_text)",
			);
		}
		if (!response.ok) {
			const bodyText = await response.text().catch(() => "");
			const classified = classifySearchHttpStatus(response.status, bodyText);
			throw new WebSearchError(
				classified.code,
				`busca falhou (HTTP ${response.status})${bodyText ? `: ${bodyText.slice(0, 300)}` : ""}`,
				classified.hint,
			);
		}
		let json: unknown;
		try {
			json = await response.json();
		} catch {
			throw new WebSearchError(
				"blocked",
				"resposta inválida do provedor de busca",
				"tente web_search com outra query ou escale para navegador (navigate + browser_text)",
			);
		}
		const results = parseSearchResponse(provider, json);
		if (results.length === 0) {
			throw new WebSearchError(
				"empty",
				"busca sem resultados",
				"tente web_search com outra query",
			);
		}
		return results;
	} finally {
		clearTimeout(timer);
	}
}
