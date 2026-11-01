/**
 * Parte B — `web_extract`: extração de conteúdo de URLs via Firecrawl cloud API.
 *
 * Atlas Search S2: este módulo virou o FALLBACK pago. A ordem agora é:
 * 1. extrator próprio (`nativeWebExtract` em `web-native.ts`, que usa
 *    `@workspace/search`: Readability→Markdown, PDF, robots, rate-limit,
 *    cache ETag) — sempre disponível, sem chave;
 * 2. Firecrawl (este arquivo) — só por URL, quando a extração própria
 *    falhar E `FIRECRAWL_API_KEY` estiver setada (ver o `case "web_extract"`
 *    em `computer-use.ts`). O conector Firecrawl do Marketplace continua
 *    opcional e separado.
 *
 * `schema` estruturado continua ignorado nesta etapa: S4 fará via LLM
 * (OpenRouter com JSON schema) sobre o Markdown limpo — sem depender de
 * provedor pago. Não implementar extração estruturada aqui.
 *
 * Bloco NOVO, sem wiring no `computer-use.ts` (o integrador fará):
 * - o integrador expõe a tool só quando `isWebExtractAvailable()` for true;
 * - idempotência/contagem usam o checkpoint existente (`toolCallCounts` +
 *   step records via `onStep` em `computer-use.ts`) — nada em memória fora
 *   do run. Não criar store novo.
 * - sem `FIRECRAWL_API_KEY`, a tool fica oculta; fallback: navegador
 *   (`navigate` + `browser_text`).
 *
 */

export type WebExtractArgs = {
	/** Máx. 5 URLs por chamada. */
	urls: string[];
	/** Quando fornecido, usa POST /v1/extract; senão scrape + formats ["markdown"]. */
	schema?: Record<string, unknown>;
	prompt?: string;
	/** Teto de chars por conteúdo; padrão 8000. */
	maxChars?: number;
};

export type WebExtractErrorCode =
	| "blocked"
	| "needs_login"
	| "empty"
	| "timeout";

export type WebExtractItemError = {
	code: WebExtractErrorCode;
	escalateHint: string;
	message: string;
};

export type WebExtractItem = {
	url: string;
	title?: string;
	fetchedAt: string;
	/** Markdown extraído (ausente quando há `error` ou quando `data` foi retornado). */
	content?: string;
	/** Payload estruturado (só no modo `schema`). */
	data?: unknown;
	truncated: boolean;
	/** O que fazer em seguida quando a página veio cortada (só aparece com `truncated`). */
	nextStep?: string;
	error?: WebExtractItemError;
};

export class WebExtractError extends Error {
	readonly code: WebExtractErrorCode;
	readonly escalateHint: string;

	constructor(code: WebExtractErrorCode, message: string, escalateHint: string) {
		super(message);
		this.name = "WebExtractError";
		this.code = code;
		this.escalateHint = escalateHint;
	}
}

/** Fetch mínimo estrutural (aceita o fetch global e mocks de teste). */
export type ExtractFetchFn = (
	input: string,
	init?: RequestInit,
) => Promise<{
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
	text(): Promise<string>;
}>;

export const WEB_EXTRACT_MAX_URLS = 5;
export const WEB_EXTRACT_DEFAULT_MAX_CHARS = 8000;
/** Teto somado da chamada: dividido entre as URLs (5 URLs = 4000 cada). */
export const WEB_EXTRACT_TOTAL_MAX_CHARS = 20_000;
export const WEB_EXTRACT_TIMEOUT_MS = 30_000;
export const WEB_EXTRACT_CONCURRENCY = 3;
export const WEB_EXTRACT_TRUNCATED_SUFFIX = "\n[truncado...]";

const FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v1/scrape";
const FIRECRAWL_EXTRACT_URL = "https://api.firecrawl.dev/v1/extract";

/** Lê a chave do Firecrawl (`FIRECRAWL_API_KEY`). */
export function resolveFirecrawlApiKey(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const key = (env.FIRECRAWL_API_KEY ?? "").trim();
	return key ? key : undefined;
}

/** Sem chave a tool fica oculta (o integrador esconde) — fallback: navegador. */
export function isWebExtractAvailable(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return resolveFirecrawlApiKey(env) !== undefined;
}

export function normalizeExtractMaxChars(raw: number | undefined): number {
	const value = Number(raw ?? WEB_EXTRACT_DEFAULT_MAX_CHARS);
	if (!Number.isFinite(value)) return WEB_EXTRACT_DEFAULT_MAX_CHARS;
	return Math.max(100, Math.min(200_000, Math.floor(value)));
}

export type BuiltExtractRequest = {
	url: string;
	endpoint: "scrape" | "extract";
	method: "POST";
	headers: Record<string, string>;
	body: string;
};

/** Requisição scrape padrão: markdown (pura: sem leitura de env, sem I/O). */
export function buildScrapeRequest(
	targetUrl: string,
	apiKey: string,
): BuiltExtractRequest {
	return {
		url: FIRECRAWL_SCRAPE_URL,
		endpoint: "scrape",
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({ url: targetUrl, formats: ["markdown"] }),
	};
}

/** Requisição de extração estruturada com `schema` (pura). */
export function buildExtractRequest(
	targetUrl: string,
	apiKey: string,
	options: { schema?: Record<string, unknown>; prompt?: string } = {},
): BuiltExtractRequest {
	const body: Record<string, unknown> = { urls: [targetUrl] };
	if (options.prompt !== undefined) body.prompt = options.prompt;
	if (options.schema !== undefined) body.schema = options.schema;
	return {
		url: FIRECRAWL_EXTRACT_URL,
		endpoint: "extract",
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify(body),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Extrai `{ title, content }` do JSON do `/v1/scrape`; null se vazio. */
export function parseScrapeResponse(json: unknown): {
	title?: string;
	content?: string;
} | null {
	if (!isRecord(json)) return null;
	const data = isRecord(json.data) ? json.data : json;
	const contentRaw = data.markdown ?? data.content ?? "";
	const content = String(contentRaw ?? "").trim();
	if (!content) return null;
	const metadata = isRecord(data.metadata) ? data.metadata : {};
	const titleRaw = metadata.title ?? data.title ?? "";
	const title = String(titleRaw ?? "").trim() || undefined;
	return { title, content };
}

/** Extrai o payload estruturado do JSON do `/v1/extract`; null se vazio. */
export function parseExtractResponse(json: unknown): { data: unknown } | null {
	if (!isRecord(json)) return null;
	if (json.data === undefined || json.data === null) return null;
	if (
		typeof json.data === "string" &&
		(json.data as string).trim() === ""
	) {
		return null;
	}
	return { data: json.data };
}

/** Aplica o teto de chars; acima dele marca `truncated` + sufixo "[truncado...]". */
export function truncateExtractContent(
	content: string,
	maxChars: number,
): { content: string; truncated: boolean } {
	if (content.length <= maxChars) return { content, truncated: false };
	return {
		content: `${content.slice(0, maxChars)}${WEB_EXTRACT_TRUNCATED_SUFFIX}`,
		truncated: true,
	};
}

function extractHintFor(
	code: WebExtractErrorCode,
	reason: string,
): string {
	if (code === "empty") {
		return "tente web_search com outra query";
	}
	return `escale para navegador navigate+browser_text, motivo: ${reason}`;
}

function classifyExtractHttpStatus(
	status: number,
	bodyText: string,
): { code: WebExtractErrorCode; reason: string } {
	const lower = bodyText.toLowerCase();
	if (status === 401 || status === 403) {
		return {
			code: "needs_login",
			reason: `Firecrawl HTTP ${status} (verifique FIRECRAWL_API_KEY)`,
		};
	}
	if (/login required|sign in|paywall|subscription/.test(lower)) {
		return { code: "needs_login", reason: "página exige login/assinatura" };
	}
	if (
		/captcha|cloudflare|access denied|blocked|bot detect|forbidden/.test(lower)
	) {
		return { code: "blocked", reason: "página bloqueou a extração automática" };
	}
	return { code: "blocked", reason: `Firecrawl HTTP ${status}` };
}

/**
 * Detects if extracted content is only navigation chrome (menu, footer, skip-links).
 * Language-agnostic: short content (<200 chars) where markdown links dominate the words.
 */
function isMenuOnlyContent(content: string): boolean {
	const trimmed = content.trim();
	if (trimmed.length >= 200) return false;
	const linkCount = (trimmed.match(/\[.*?\]\(.*?\)/g) || []).length;
	const linkRatio = linkCount / Math.max(1, trimmed.split(/\s+/).length);
	return linkRatio > 0.3;
}

export type ExecuteWebExtractOptions = {
	apiKey?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	env?: NodeJS.ProcessEnv;
};

async function fetchOneUrl(input: {
	targetUrl: string;
	request: BuiltExtractRequest;
	useSchema: boolean;
	maxChars: number;
	fetchFn: ExtractFetchFn;
	timeoutMs: number;
	parentSignal?: AbortSignal;
}): Promise<WebExtractItem> {
	const fetchedAt = new Date().toISOString();
	const fail = (
		code: WebExtractErrorCode,
		message: string,
		reason: string,
	): WebExtractItem => ({
		url: input.targetUrl,
		fetchedAt,
		truncated: false,
		error: { code, message, escalateHint: extractHintFor(code, reason) },
	});

	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, input.timeoutMs);
	if (input.parentSignal) {
		if (input.parentSignal.aborted) controller.abort();
		else {
			input.parentSignal.addEventListener("abort", () => controller.abort(), {
				once: true,
			});
		}
	}
	try {
		let response: Awaited<ReturnType<ExtractFetchFn>>;
		try {
			response = await input.fetchFn(input.request.url, {
				method: input.request.method,
				headers: input.request.headers,
				body: input.request.body,
				signal: controller.signal,
			});
		} catch (error) {
			if (
				timedOut ||
				(error instanceof Error &&
					(error.name === "TimeoutError" || error.name === "AbortError"))
			) {
				const reason = `timeout após ${input.timeoutMs}ms em ${input.targetUrl}`;
				return fail("timeout", reason, reason);
			}
			const message = error instanceof Error ? error.message : "falha de rede";
			const reason = `rede falhou em ${input.targetUrl}: ${message}`;
			return fail("blocked", reason, reason);
		}
		if (!response.ok) {
			const bodyText = await response.text().catch(() => "");
			const classified = classifyExtractHttpStatus(response.status, bodyText);
			return fail(
				classified.code,
				`extração falhou em ${input.targetUrl} (HTTP ${response.status})`,
				classified.reason,
			);
		}
		let json: unknown;
		try {
			json = await response.json();
		} catch {
			const reason = `resposta inválida do Firecrawl em ${input.targetUrl}`;
			return fail("blocked", reason, reason);
		}
		if (input.useSchema) {
			const parsed = parseExtractResponse(json);
			if (!parsed) {
				const reason = `extração vazia em ${input.targetUrl}`;
				return fail("empty", reason, reason);
			}
			return { url: input.targetUrl, fetchedAt, data: parsed.data, truncated: false };
		}
		const parsed = parseScrapeResponse(json);
		if (!parsed?.content) {
			const reason = `extração vazia em ${input.targetUrl}`;
			return fail("empty", reason, reason);
		}
		if (isMenuOnlyContent(parsed.content)) {
			const reason = `conteúdo é apenas navegação em ${input.targetUrl}`;
			return fail("empty", reason, reason);
		}
		const truncated = truncateExtractContent(parsed.content, input.maxChars);
		return {
			url: input.targetUrl,
			title: parsed.title,
			fetchedAt,
			content: truncated.content,
			truncated: truncated.truncated,
		};
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Extrai até 5 URLs em paralelo (lotes de 3 via `Promise.allSettled`).
 * Erros são por URL (`item.error` com `code` + `escalateHint`); a ordem de
 * entrada é preservada. Falta de chave vira `WebExtractError` (a tool deve
 * ficar oculta nesse caso — ver `isWebExtractAvailable()`).
 */
export async function executeWebExtract(
	args: WebExtractArgs,
	fetchFn?: ExtractFetchFn,
	options: ExecuteWebExtractOptions = {},
): Promise<WebExtractItem[]> {
	const urls = (args.urls ?? []).map((url) => String(url ?? "").trim());
	if (urls.length === 0 || urls.some((url) => !url)) {
		throw new WebExtractError(
			"empty",
			"urls vazio ou com URL em branco (máx. 5 por chamada)",
			"tente web_search com outra query",
		);
	}
	if (urls.length > WEB_EXTRACT_MAX_URLS) {
		throw new WebExtractError(
			"blocked",
			`máximo de ${WEB_EXTRACT_MAX_URLS} URLs por chamada (recebido ${urls.length})`,
			"divida em chamadas de até 5 URLs",
		);
	}
	const env = options.env ?? process.env;
	const apiKey = options.apiKey ?? resolveFirecrawlApiKey(env);
	if (!apiKey) {
		throw new WebExtractError(
			"blocked",
			"extração indisponível: FIRECRAWL_API_KEY ausente",
			"sem chave, a tool web_extract fica oculta; fallback: navegador (navigate + browser_text)",
		);
	}
	const doFetch: ExtractFetchFn | undefined =
		fetchFn ?? (globalThis.fetch as unknown as ExtractFetchFn | undefined);
	if (!doFetch) {
		throw new WebExtractError(
			"blocked",
			"fetch indisponível neste ambiente",
			"escale para navegador navigate+browser_text, motivo: fetch indisponível",
		);
	}
	const useSchema = args.schema !== undefined;
	const maxChars = Math.min(
		normalizeExtractMaxChars(args.maxChars),
		Math.floor(WEB_EXTRACT_TOTAL_MAX_CHARS / urls.length),
	);
	const timeoutMs = options.timeoutMs ?? WEB_EXTRACT_TIMEOUT_MS;
	const results: WebExtractItem[] = new Array(urls.length);
	for (let start = 0; start < urls.length; start += WEB_EXTRACT_CONCURRENCY) {
		const chunk = urls
			.slice(start, start + WEB_EXTRACT_CONCURRENCY)
			.map((targetUrl, offset) => ({ targetUrl, index: start + offset }));
		const settled = await Promise.allSettled(
			chunk.map(({ targetUrl }) =>
				fetchOneUrl({
					targetUrl,
					request: useSchema
						? buildExtractRequest(targetUrl, apiKey, {
								schema: args.schema,
								prompt: args.prompt,
							})
						: buildScrapeRequest(targetUrl, apiKey),
					useSchema,
					maxChars,
					fetchFn: doFetch,
					timeoutMs,
					parentSignal: options.signal,
				}),
			),
		);
		settled.forEach((entry, offset) => {
			const slot = chunk[offset]?.index ?? start + offset;
			if (entry.status === "fulfilled") {
				results[slot] = entry.value;
			} else {
				const message =
					entry.reason instanceof Error
						? entry.reason.message
						: "falha inesperada na extração";
				const targetUrl = chunk[offset]?.targetUrl ?? urls[slot] ?? "";
				const reason = `falha inesperada em ${targetUrl}: ${message}`;
				results[slot] = {
					url: targetUrl,
					fetchedAt: new Date().toISOString(),
					truncated: false,
					error: { code: "blocked", message, escalateHint: extractHintFor("blocked", reason) },
				};
			}
		});
	}
	return results;
}

// ---------------------------------------------------------------------------
// Gancho Parte C — planilhas (NÃO implementar `googleapis` aqui).
// ---------------------------------------------------------------------------

/** Dica do item sem navegador no run: não manda o modelo para uma tool que ele não tem. */
export const NO_BROWSER_EXTRACT_HINT =
	"this page could not be read here; try web_search for another source, or tell the user it could not be opened";

export function adaptEscalateHints(items: WebExtractItem[], hasBrowser: boolean): WebExtractItem[] {
	if (hasBrowser) return items;
	return items.map((item) =>
		item.error
			? { ...item, error: { ...item.error, escalateHint: NO_BROWSER_EXTRACT_HINT } }
			: item,
	);
}

/** Repositório de código: o arquivo bruto costuma abrir onde a página renderizada falha ou vem cortada. */
function rawFileAdvice(url: string): string {
	let host = "";
	try {
		host = new URL(url).hostname.toLowerCase();
	} catch {
		return "";
	}
	if (host === "github.com" || host === "www.github.com") return " For a file in a GitHub repository open the raw version (https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<path>), or the repository README/docs path directly.";
	if (host.includes("gitlab")) return " For a file in a GitLab repository open its /-/raw/<branch>/<path> version.";
	return "";
}

/**
 * Não desistir no primeiro bloqueio (trabalho longo): página bloqueada, com erro de leitura ou cortada volta com a
 * alternativa concreta, para o modelo tentar outra via antes de marcar "não confirmado". A tool não tem `offset`:
 * "ler em partes" = uma URL por chamada com `maxChars` maior, ou buscar o trecho. Texto para o modelo (inglês).
 */
export function addRecoveryGuidance(items: WebExtractItem[]): WebExtractItem[] {
	return items.map((item) => {
		if (item.error) {
			if (item.error.code === "empty") return item;
			const advice =
				"Do not give up on the first block: try another source for the same fact (web_search the fact with different words, the official site, docs, a mirror or an archived copy)" +
				`${rawFileAdvice(item.url)} Only mark it unconfirmed after a second route also failed.`;
			// Sem ponto duplo: a dica original pode já terminar em pontuação.
			const hint = item.error.escalateHint.replace(/[\s.]+$/, "");
			return { ...item, error: { ...item.error, escalateHint: `${hint}. ${advice}` } };
		}
		if (item.truncated) {
			return {
				...item,
				nextStep:
					"The page came back cut. Read the rest: call web_extract again with this single URL and maxChars up to 20000 (the cap for one URL), or web_search the exact term you need to find the part that matters." +
					rawFileAdvice(item.url),
			};
		}
		return item;
	});
}
