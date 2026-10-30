/**
 * Leitor de fonte de alerta (I/O): busca a página ou o feed de uma regra e entrega a leitura pronta para o
 * avaliador puro de `@workspace/shared`. Sem modelo, sem cookies, sem credenciais.
 *
 * Segurança (a fonte é uma URL escolhida pelo agente a pedido do usuário, então é entrada não confiável):
 * - só http(s); bloqueia loopback, rede privada, link-local e metadados de nuvem, inclusive depois do DNS e
 *   em cada redirect (no máximo 3); o `connect` real também recusa IP privado (DNS rebinding);
 * - timeout total de 10 s e no máximo 5 MB por resposta (acima disso é erro, nunca leitura parcial);
 * - o conteúdo lido é só dado: vira texto/valor, nunca instrução.
 *
 * Cache por ciclo: alertas que olham a mesma URL compartilham uma única busca (TTL curto, em memória). Não há
 * dado de usuário na chave nem na resposta (a busca é anônima), então compartilhar entre donos é seguro.
 */
import { lookup as dnsLookup } from "node:dns";
import { parseHTML } from "linkedom";
import { Agent, fetch as undiciFetch } from "undici";
import {
	ExtractError,
	assertPublicExtractUrl,
	isAllowedByRobots,
	isPrivateExtractAddress,
	type ExtractFetchFn,
	type ExtractLookupFn,
} from "./extract.js";
import { regexWindow, runRegexWithBudget } from "./regex-budget.js";
import {
	ALERT_FEED_ITEMS_MAX,
	ALERT_ITEM_TITLE_MAX,
	alertSourceHost,
	isMarketAlertSource,
	unsafeRegexReason,
	jsonValueText,
	parseFeedItems,
	readJsonPath,
	type AlertRule,
	type AlertRuleRead,
	type AlertSource,
} from "@workspace/shared";

export const ALERT_SOURCE_UA = "atlas-agent/0.1 (+https://github.com/ali-ali18/Atlas)";
export const ALERT_SOURCE_TIMEOUT_MS = 10_000;
export const ALERT_SOURCE_MAX_BYTES = 5_000_000;
export const ALERT_SOURCE_MAX_REDIRECTS = 3;
export const ALERT_SOURCE_CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 200;
const LIST_ITEMS_MAX = ALERT_FEED_ITEMS_MAX;

export type AlertSourceFailure = "blocked" | "timeout" | "http" | "too_large" | "network" | "parse" | "empty";

export type AlertSourceResult =
	| { ok: true; read: AlertRuleRead; host: string; ms: number }
	| { ok: false; code: AlertSourceFailure; reason: string; host: string; ms: number };

type FetchedDocument = { body: string; contentType: string };
export type AlertSourceCache = Map<string, { expiresAt: number; promise: Promise<FetchedDocument> }>;

export type AlertSourceDeps = {
	fetchFn?: ExtractFetchFn;
	lookupFn?: ExtractLookupFn;
	timeoutMs?: number;
	maxBytes?: number;
	/** Respeita o robots.txt do site (padrão: sim; o resultado fica em cache por origem). */
	respectRobots?: boolean;
	/** Busca única por URL entre alertas do mesmo ciclo. Ausente = sem cache (ex.: teste da regra na criação). */
	cache?: AlertSourceCache;
	now?: () => number;
};

export function createAlertSourceCache(): AlertSourceCache {
	return new Map();
}

class SourceError extends Error {
	constructor(
		readonly code: AlertSourceFailure,
		message: string,
	) {
		super(message);
	}
}

const defaultLookup: ExtractLookupFn = async (hostname) =>
	await new Promise((resolve, reject) => {
		dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => (error ? reject(error) : resolve(addresses.map((entry) => entry.address))));
	});

/** Conexão real que recusa IP privado no momento de conectar (fecha a janela entre checar o DNS e conectar). */
let pinnedAgent: Agent | undefined;
function guardedFetch(): ExtractFetchFn {
	pinnedAgent ??= new Agent({
		connect: {
			lookup: (hostname, options, callback) => {
				dnsLookup(hostname, { ...options, all: true, verbatim: true }, (error, addresses) => {
					const list = Array.isArray(addresses) ? addresses : [];
					if (error || list.length === 0) return callback(error ?? new Error("sem endereço"), "", 4);
					if (list.some((entry) => isPrivateExtractAddress(entry.address))) return callback(new Error("endereço interno não permitido"), "", 4);
					// `all` é do chamador: net.connect pede a lista (autoSelectFamily) ou só o primeiro.
					if (options.all) return (callback as unknown as (e: null, a: typeof list) => void)(null, list);
					return callback(null, list[0]!.address, list[0]!.family);
				});
			},
		},
		connectTimeout: ALERT_SOURCE_TIMEOUT_MS,
	});
	const dispatcher = pinnedAgent;
	return (input, init) => undiciFetch(input, { ...(init as object), dispatcher }) as unknown as Promise<Response>;
}

async function readBodyCapped(response: Response, maxBytes: number): Promise<string> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > maxBytes) {
		await response.body?.cancel().catch(() => undefined);
		throw new SourceError("too_large", "a página é grande demais para conferir");
	}
	if (!response.body) {
		const text = await response.text();
		if (text.length > maxBytes) throw new SourceError("too_large", "a página é grande demais para conferir");
		return text;
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done || !value) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel().catch(() => undefined);
			throw new SourceError("too_large", "a página é grande demais para conferir");
		}
		chunks.push(value);
	}
	return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
}

/** GET anônimo; cada salto de redirect passa de novo pelo guard SSRF. */
async function fetchDocument(rawUrl: string, deps: AlertSourceDeps): Promise<FetchedDocument> {
	const fetchFn = deps.fetchFn ?? guardedFetch();
	const lookupFn = deps.lookupFn ?? defaultLookup;
	const maxBytes = deps.maxBytes ?? ALERT_SOURCE_MAX_BYTES;
	const signal = AbortSignal.timeout(deps.timeoutMs ?? ALERT_SOURCE_TIMEOUT_MS);
	let current = rawUrl;
	try {
		for (let hop = 0; hop <= ALERT_SOURCE_MAX_REDIRECTS; hop += 1) {
			let url: URL;
			try {
				url = await assertPublicExtractUrl(current, lookupFn);
			} catch (error) {
				if (error instanceof ExtractError) throw new SourceError("blocked", error.code === "blocked" ? "endereço não permitido (só sites públicos)" : "não consegui resolver o endereço");
				throw error;
			}
			if (deps.respectRobots !== false && !(await isAllowedByRobots(url, fetchFn, signal))) {
				throw new SourceError("blocked", "o site pede para não ser lido por programas (robots.txt)");
			}
			const response = await fetchFn(url.toString(), {
				method: "GET",
				redirect: "manual",
				signal,
				headers: {
					"User-Agent": ALERT_SOURCE_UA,
					Accept: "text/html,application/xhtml+xml,application/xml,application/rss+xml,application/atom+xml,application/json;q=0.9,*/*;q=0.5",
				},
			});
			const location = response.headers.get("location");
			if (response.status >= 300 && response.status < 400 && location) {
				await response.body?.cancel().catch(() => undefined);
				current = new URL(location, url).toString();
				continue;
			}
			if (response.status < 200 || response.status >= 300) {
				await response.body?.cancel().catch(() => undefined);
				throw new SourceError("http", `o site recusou ou falhou (HTTP ${response.status})`);
			}
			return { body: await readBodyCapped(response, maxBytes), contentType: (response.headers.get("content-type") ?? "").toLowerCase() };
		}
		throw new SourceError("blocked", "redirecionamentos demais");
	} catch (error) {
		if (error instanceof SourceError) throw error;
		if (signal.aborted || (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))) throw new SourceError("timeout", "o site não respondeu a tempo");
		throw new SourceError("network", "não consegui acessar o site");
	}
}

function fetchShared(url: string, deps: AlertSourceDeps): Promise<FetchedDocument> {
	const cache = deps.cache;
	if (!cache) return fetchDocument(url, deps);
	const now = (deps.now ?? Date.now)();
	const hit = cache.get(url);
	if (hit && hit.expiresAt > now) return hit.promise;
	if (cache.size >= CACHE_MAX_ENTRIES) {
		for (const [key, entry] of cache) if (entry.expiresAt <= now) cache.delete(key);
		if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
	}
	const promise = fetchDocument(url, deps);
	cache.set(url, { expiresAt: now + ALERT_SOURCE_CACHE_TTL_MS, promise });
	return promise;
}

function squeeze(text: string | null | undefined): string {
	return (text ?? "").replace(/\s+/g, " ").trim();
}

async function readPage(source: Extract<AlertSource, { type: "page" }>, doc: FetchedDocument, wantList: boolean): Promise<AlertRuleRead> {
	const extract = source.extract;
	if (extract.kind === "regex") {
		if (unsafeRegexReason(extract.pattern)) throw new SourceError("parse", "o padrão de leitura não é seguro");
		const run = await runRegexWithBudget(regexWindow(doc.body), extract.pattern);
		if (run.status === "timeout") throw new SourceError("parse", "o padrão de leitura demorou demais (regex lenta)");
		if (run.status === "error") throw new SourceError("parse", "o padrão de leitura é inválido");
		return { kind: "text", text: run.status === "match" ? run.value : null };
	}
	if (extract.kind === "jsonpath") {
		let data: unknown;
		try {
			data = JSON.parse(doc.body);
		} catch {
			throw new SourceError("parse", "a fonte não devolveu JSON");
		}
		return { kind: "text", text: jsonValueText(readJsonPath(data, extract.path)) };
	}
	const { document } = parseHTML(doc.body);
	let nodes: Element[];
	try {
		nodes = Array.from(document.querySelectorAll(extract.selector)).slice(0, wantList ? LIST_ITEMS_MAX : 1) as Element[];
	} catch {
		throw new SourceError("parse", "o seletor da página é inválido");
	}
	const textOf = (node: Element) => squeeze(extract.attribute ? node.getAttribute(extract.attribute) : node.textContent);
	if (wantList) {
		const items = nodes.map((node) => ({ title: textOf(node).slice(0, ALERT_ITEM_TITLE_MAX), link: squeeze(node.querySelector("a")?.getAttribute("href") ?? node.getAttribute("href")) || undefined })).filter((item) => item.title);
		return { kind: "items", items: items.map((item) => ({ title: item.title, ...(item.link ? { link: toAbsolute(item.link, source.url) } : {}) })) };
	}
	return { kind: "text", text: nodes[0] ? textOf(nodes[0]) || null : null };
}

function toAbsolute(href: string, base: string): string {
	try {
		return new URL(href, base).toString();
	} catch {
		return href;
	}
}

function readFeed(doc: FetchedDocument): AlertRuleRead {
	if (!/<(rss|feed|rdf:RDF|channel)\b/i.test(doc.body.slice(0, 5000))) throw new SourceError("parse", "a fonte não parece um feed (RSS/Atom)");
	return { kind: "items", items: parseFeedItems(doc.body) };
}

/**
 * Lê a fonte de uma regra. Nunca lança: falha vira `{ ok: false, code, reason }` com texto simples (pt-BR) que
 * pode ir ao usuário e ao modelo, sem URL completa (a query pode ter chave).
 */
export async function readAlertSource(source: AlertSource, deps: AlertSourceDeps = {}, wantList = false): Promise<AlertSourceResult> {
	const clock = deps.now ?? Date.now;
	const started = clock();
	const host = alertSourceHost(source);
	// Fontes de mercado (sem URL) são lidas pelos provedores de `market-data.ts`, não por este leitor de páginas.
	if (isMarketAlertSource(source)) return { ok: false, code: "network", reason: "fonte de mercado fora do leitor de páginas", host, ms: 0 };
	try {
		const doc = await fetchShared(source.url, deps);
		const read = source.type === "feed" ? readFeed(doc) : await readPage(source, doc, wantList);
		return { ok: true, read, host, ms: clock() - started };
	} catch (error) {
		if (error instanceof SourceError) return { ok: false, code: error.code, reason: error.message, host, ms: clock() - started };
		return { ok: false, code: "network", reason: "não consegui ler a fonte", host, ms: clock() - started };
	}
}


/** Lê a fonte da regra (lista de itens quando a verificação é "item novo"). */
export function readAlertRule(rule: AlertRule, deps: AlertSourceDeps = {}): Promise<AlertSourceResult> {
	return readAlertSource(rule.source, deps, rule.check.kind === "new_item");
}
