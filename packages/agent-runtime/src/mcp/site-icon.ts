import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { sniffImageType } from "@workspace/shared";
import { Agent } from "undici";
import { assertPublicUrl, isPrivateAddress, type NativeFetchFn, type NativeLookupFn } from "../web-native.js";

/**
 * Logo de um servidor MCP, resolvida no servidor (o navegador nunca fala com o
 * site de terceiros). Ordem: `logo_uri` dos metadados OAuth do servidor, depois
 * `<link rel="icon">`/apple-touch-icon da home do domínio e `/favicon.ico`.
 * Sem imagem válida, devolve `null` e a UI mostra a inicial do nome.
 */

export type SiteIcon = { bytes: Buffer; contentType: string };

export const SITE_ICON_MAX_BYTES = 256 * 1024;
const HTML_MAX_BYTES = 512 * 1024;
const REQUEST_TIMEOUT_MS = 4_000;
const TOTAL_TIMEOUT_MS = 12_000;
const HIT_TTL_MS = 6 * 60 * 60_000;
const MISS_TTL_MS = 10 * 60_000;
const CACHE_MAX = 300;

const cache = new Map<string, { at: number; value: SiteIcon | null }>();

export function clearSiteIconCache(): void {
	cache.clear();
}

export type SiteIconDeps = {
	fetchFn?: NativeFetchFn;
	lookupFn?: NativeLookupFn;
	now?: () => number;
};

/** Hostnames válidos para o proxy (o mesmo formato do caminho `/v1/mcp/icon/:host`). */
export function parseIconHostname(raw: string): string | null {
	const host = raw.trim().toLowerCase();
	if (host.length > 253 || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) return null;
	return host;
}

const SECOND_LEVEL = new Set(["com", "co", "org", "net", "gov", "edu", "ac"]);

/** Domínio do hostname e seus pais (até 2 rótulos; 3 em `com.br`, `co.uk`...). */
export function iconHostCandidates(hostname: string): string[] {
	const labels = hostname.split(".");
	const result: string[] = [hostname];
	for (let i = 1; i < labels.length - 1; i++) {
		const rest = labels.slice(i);
		const isPublicSuffix = rest.length === 2 && SECOND_LEVEL.has(rest[0]!) && rest[1]!.length === 2;
		if (rest.length < 2 || isPublicSuffix) break;
		result.push(rest.join("."));
	}
	return result.slice(0, 3);
}

function looksLikeSvg(bytes: Buffer): boolean {
	const head = bytes.subarray(0, 1024).toString("utf8").toLowerCase();
	return head.includes("<svg") && !head.startsWith("<!doctype html") && !head.includes("<html");
}

/** Reconhece o formato pelos bytes (nunca confia só no content-type). */
export function sniffIconType(bytes: Buffer): string | null {
	if (bytes.length < 4 || bytes.length > SITE_ICON_MAX_BYTES) return null;
	const raster = sniffImageType(bytes);
	if (raster) return raster;
	if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) return "image/x-icon";
	if (looksLikeSvg(bytes)) return "image/svg+xml";
	return null;
}

export function makeFetch(lookupFn: NativeLookupFn, fetchFn?: NativeFetchFn): { fetchFn: NativeFetchFn; close: () => Promise<void> } {
	if (fetchFn) return { fetchFn, close: async () => undefined };
	// A conexão valida o DNS de novo e fixa o endereço no socket (anti-rebinding).
	const dispatcher = new Agent({
		connect: {
			lookup: (hostname, options, callback) => {
				lookupFn(hostname).then(
					(addresses) => {
						if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
							callback(new Error("URL bloqueada: endereço privado ou DNS inválido."), "", 4);
							return;
						}
						// Node 20+ pede `all: true` (autoSelectFamily): o callback então recebe a lista.
						if ((options as { all?: boolean }).all) {
							(callback as unknown as (error: null, list: { address: string; family: number }[]) => void)(
								null,
								addresses.map((address) => ({ address, family: isIP(address) || 4 })),
							);
							return;
						}
						const address = addresses[0]!;
						callback(null, address, isIP(address));
					},
					(error: unknown) => callback(error instanceof Error ? error : new Error("DNS inválido."), "", 4),
				);
			},
		},
	});
	return {
		fetchFn: (url, init) => fetch(url, { ...init, dispatcher } as RequestInit),
		close: () => dispatcher.close(),
	};
}

async function readLimited(response: Response, max: number): Promise<Buffer | null> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > max) {
		await response.body?.cancel().catch(() => undefined);
		return null;
	}
	if (!response.body) return null;
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.byteLength;
			if (length > max) return null;
			chunks.push(value);
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	return Buffer.concat(chunks);
}

type Getter = (url: string, accept: string, max: number) => Promise<{ bytes: Buffer; finalUrl: string; contentType: string } | null>;

function makeGetter(deps: SiteIconDeps, signal: AbortSignal): { get: Getter; close: () => Promise<void> } {
	const lookupFn = deps.lookupFn ?? (async (hostname: string) => (await dnsLookup(hostname, { all: true })).map((entry) => entry.address));
	const { fetchFn, close } = makeFetch(lookupFn, deps.fetchFn);
	const get: Getter = async (rawUrl, accept, max) => {
		let current = rawUrl;
		try {
			for (let hop = 0; hop <= 3; hop++) {
				const url = await assertPublicUrl(current, lookupFn);
				if (url.protocol !== "https:") return null;
				const response = await fetchFn(url.toString(), {
					method: "GET",
					redirect: "manual",
					headers: { Accept: accept, "User-Agent": "AtlasIconFetcher/1.0" },
					signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
				});
				if (response.status >= 300 && response.status < 400) {
					const location = response.headers.get("location");
					await response.body?.cancel().catch(() => undefined);
					if (!location) return null;
					current = new URL(location, url).toString();
					continue;
				}
				if (!response.ok) {
					await response.body?.cancel().catch(() => undefined);
					return null;
				}
				const bytes = await readLimited(response, max);
				return bytes ? { bytes, finalUrl: url.toString(), contentType: response.headers.get("content-type") ?? "" } : null;
			}
		} catch {
			return null;
		}
		return null;
	};
	return { get, close };
}

function jsonObject(bytes: Buffer): Record<string, unknown> | null {
	try {
		const value: unknown = JSON.parse(bytes.toString("utf8"));
		return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/** `<link rel="icon|shortcut icon|apple-touch-icon" href>` da home, melhor candidato primeiro. */
export function parseIconLinks(html: string, baseUrl: string): string[] {
	const found: { href: string; score: number }[] = [];
	for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
		const rel = /\brel\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase() ?? "";
		const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.trim();
		if (!href || !/\b(icon|apple-touch-icon|apple-touch-icon-precomposed)\b/.test(rel)) continue;
		if (/^data:/i.test(href)) continue;
		const sizes = /\bsizes\s*=\s*["'](\d+)x\d+/i.exec(tag)?.[1];
		const size = sizes ? Number(sizes) : 0;
		// Prefere ícone pequeno-médio e nítido (≈64–180px); SVG é sempre bom.
		let score = rel.includes("apple-touch") ? 50 : 30;
		if (/\.svg(\?|$)/i.test(href)) score += 40;
		else if (size >= 48 && size <= 200) score += 25;
		else if (size > 200) score += 5;
		try {
			found.push({ href: new URL(href, baseUrl).toString(), score });
		} catch {
			// href inválido: ignora.
		}
	}
	return found.sort((a, b) => b.score - a.score).map((item) => item.href).slice(0, 4);
}

async function tryImage(get: Getter, url: string): Promise<SiteIcon | null> {
	const res = await get(url, "image/svg+xml,image/png,image/*;q=0.8", SITE_ICON_MAX_BYTES);
	if (!res || !/^image\//i.test(res.contentType.split(";")[0]!.trim()) && !/\.(ico|svg|png)(\?|$)/i.test(res.finalUrl)) return null;
	const contentType = sniffIconType(res.bytes);
	return contentType ? { bytes: res.bytes, contentType } : null;
}

async function resolveUncached(hostname: string, deps: SiteIconDeps): Promise<SiteIcon | null> {
	const signal = AbortSignal.timeout(TOTAL_TIMEOUT_MS);
	const { get, close } = makeGetter(deps, signal);
	try {
		const hosts = iconHostCandidates(hostname);
		// 1) Logo declarada nos metadados OAuth do próprio servidor MCP.
		for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server"]) {
			const meta = await get(`https://${hostname}${path}`, "application/json", 64 * 1024);
			const doc = meta ? jsonObject(meta.bytes) : null;
			const logo = [doc?.logo_uri, doc?.resource_logo_uri].find((value): value is string => typeof value === "string");
			if (logo) {
				const icon = await tryImage(get, new URL(logo, `https://${hostname}/`).toString());
				if (icon) return icon;
			}
		}
		// 2) Favicon/apple-touch-icon do domínio (servidor e domínio registrável).
		for (const host of hosts) {
			const home = await get(`https://${host}/`, "text/html", HTML_MAX_BYTES);
			if (home && /html/i.test(home.contentType)) {
				for (const href of parseIconLinks(home.bytes.toString("utf8"), home.finalUrl)) {
					const icon = await tryImage(get, href);
					if (icon) return icon;
				}
			}
			const fallback = await tryImage(get, `https://${host}/favicon.ico`);
			if (fallback) return fallback;
		}
		return null;
	} catch {
		return null;
	} finally {
		await close().catch(() => undefined);
	}
}

/** Logo do servidor (em cache por 6h; ausência por 10 min). Nunca lança. */
export async function resolveSiteIcon(hostname: string, deps: SiteIconDeps = {}): Promise<SiteIcon | null> {
	const host = parseIconHostname(hostname);
	if (!host) return null;
	const now = (deps.now ?? Date.now)();
	const hit = cache.get(host);
	if (hit && now - hit.at < (hit.value ? HIT_TTL_MS : MISS_TTL_MS)) return hit.value;
	const value = await resolveUncached(host, deps);
	if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
	cache.set(host, { at: now, value });
	return value;
}
