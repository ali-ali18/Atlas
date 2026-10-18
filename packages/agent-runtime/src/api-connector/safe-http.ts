import { lookup as dnsLookup } from "node:dns/promises";
import { makeFetch } from "../mcp/site-icon.js";
import { assertPublicUrl, type NativeFetchFn, type NativeLookupFn } from "../web-native.js";

/**
 * HTTP de saída do conector de API. Toda requisição passa pelo guard SSRF do
 * projeto (`assertPublicUrl`), com DNS fixado no socket (anti-rebinding),
 * https obrigatório, redirects manuais revalidados, timeout e teto de bytes.
 */

export type SafeHttpDeps = {
	fetchFn?: NativeFetchFn;
	lookupFn?: NativeLookupFn;
};

export type SafeHttpOptions = {
	method?: "GET" | "HEAD" | "POST";
	headers?: Record<string, string>;
	body?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	maxBytes?: number;
	maxRedirects?: number;
	/**
	 * Redirect só para o mesmo host da requisição inicial (chamadas de API com
	 * credencial): outro host aborta, para a credencial nunca sair do domínio fixado.
	 */
	sameHostRedirectsOnly?: boolean;
};

export type SafeHttpResponse = {
	status: number;
	headers: Headers;
	text: string;
	/** O corpo passou de `maxBytes` e foi cortado. */
	truncated: boolean;
	/** Total anunciado, quando o servidor informa. */
	totalBytes?: number;
	finalUrl: string;
};

export class SafeHttpError extends Error {
	constructor(
		readonly code: "blocked" | "timeout" | "network" | "redirect",
		message: string,
	) {
		super(message);
		this.name = "SafeHttpError";
	}
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 1_000_000;

async function readCapped(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
	if (!response.body) return { text: "", truncated: false };
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let truncated = false;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			chunks.push(value);
			if (total > maxBytes) {
				truncated = true;
				break;
			}
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	const merged = Buffer.concat(chunks);
	return { text: merged.subarray(0, maxBytes).toString("utf8"), truncated };
}

export async function safeHttpRequest(rawUrl: string, options: SafeHttpOptions = {}, deps: SafeHttpDeps = {}): Promise<SafeHttpResponse> {
	const lookupFn: NativeLookupFn = deps.lookupFn ?? (async (hostname) => (await dnsLookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address));
	const { fetchFn, close } = makeFetch(lookupFn, deps.fetchFn);
	const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const maxRedirects = options.maxRedirects ?? 4;
	let current = rawUrl;
	let firstHost: string | null = null;
	try {
		for (let hop = 0; hop <= maxRedirects; hop += 1) {
			let url: URL;
			try {
				url = await assertPublicUrl(current, lookupFn);
			} catch (error) {
				throw new SafeHttpError("blocked", error instanceof Error ? error.message : "URL bloqueada");
			}
			if (url.protocol !== "https:") throw new SafeHttpError("blocked", "Somente URLs https são permitidas.");
			firstHost ??= url.hostname.toLowerCase();
			if (options.sameHostRedirectsOnly && url.hostname.toLowerCase() !== firstHost) {
				throw new SafeHttpError("redirect", "A API tentou redirecionar para outro domínio; bloqueado.");
			}
			let response: Response;
			try {
				response = await fetchFn(url.toString(), {
					method: options.method ?? "GET",
					redirect: "manual",
					signal,
					headers: options.headers,
					...(options.body !== undefined ? { body: options.body } : {}),
				});
			} catch (error) {
				if (timeout.aborted) throw new SafeHttpError("timeout", "A API demorou demais para responder.");
				if (options.signal?.aborted) throw error;
				const message = error instanceof Error ? error.message : "";
				const blocked = message.includes("bloqueada");
				throw new SafeHttpError(blocked ? "blocked" : "network", blocked ? message : "Não foi possível alcançar a API.");
			}
			const location = response.headers.get("location");
			if (response.status >= 300 && response.status < 400 && location) {
				await response.body?.cancel().catch(() => undefined);
				current = new URL(location, url).toString();
				continue;
			}
			const declared = Number(response.headers.get("content-length"));
			const body = options.method === "HEAD" ? { text: "", truncated: false } : await readCapped(response, maxBytes);
			return {
				status: response.status,
				headers: response.headers,
				text: body.text,
				truncated: body.truncated,
				...(Number.isFinite(declared) && declared > 0 ? { totalBytes: declared } : {}),
				finalUrl: url.toString(),
			};
		}
		throw new SafeHttpError("redirect", "Redirecionamentos demais.");
	} finally {
		await close().catch(() => undefined);
	}
}
