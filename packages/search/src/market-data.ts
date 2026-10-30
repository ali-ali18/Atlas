/**
 * Fontes de mercado dos alertas (etapa 2): cotação da B3, câmbio, cripto e clima, lidas sem modelo e sem URL
 * vinda do usuário ou do modelo. Cada provedor tem host FIXO no código; a chamada é montada só a partir de campos
 * já validados (`parseAlertRule`) e escapados. Sem redirect, só https, timeout curto e teto de tamanho.
 *
 * Provedores (todos conferidos nos termos públicos; ver docs/features/alertas-inteligentes.md):
 * - cotação B3: brapi.dev (chave do próprio usuário, guardada no cofre; o chamador resolve e entrega em memória).
 *   Vaga reservada para a bolsai (API com chave; sem documentação pública de endpoints, então não implementada);
 * - câmbio: AwesomeAPI (sem chave);
 * - cripto: Mercado Bitcoin (BRL) e Binance market data (BRL/USD), sem chave, um de reserva do outro;
 * - clima: Open-Meteo (sem chave), com geocodificação da cidade.
 * Yahoo Finance está FORA: o robots.txt proíbe leitura automática.
 *
 * Compartilhado entre alertas e donos: cache curto por símbolo (60 s, valor de mercado não é segredo), com a
 * busca em andamento reaproveitada, e saúde por provedor (backoff exponencial; 429 respeita Retry-After). A cota
 * é por chave: a falha de uma chave não derruba os outros donos (a saúde do provedor com chave é por impressão
 * digital curta da chave, nunca a chave).
 */
import { createHash } from "node:crypto";
import { b3Session, type AlertMarketSource, type AlertRuleRead } from "@workspace/shared";

export const MARKET_TIMEOUT_MS = 8_000;
export const MARKET_MAX_BYTES = 256_000;
export const MARKET_CACHE_TTL_MS = 60_000;
export const MARKET_UA = "atlas-agent/0.1 (+https://github.com/ali-ali18/Atlas)";
const CACHE_MAX_ENTRIES = 500;
/** Cotação mais velha que isso é "desatualizada" mesmo fora do pregão (fim de semana + feriado prolongado). */
const QUOTE_STALE_MS = 6 * 86_400_000;

export type MarketFailure = "needs_key" | "auth" | "rate_limit" | "not_found" | "http" | "timeout" | "network" | "parse" | "stale" | "market_closed";

export type MarketResult =
	| { ok: true; read: AlertRuleRead; host: string; ms: number; provider: string }
	| { ok: false; code: MarketFailure; reason: string; host: string; ms: number };

/** Chaves já abertas do cofre do DONO do alerta, só em memória durante a chamada. */
export type MarketKeys = { brapi?: string };

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export type MarketHealth = Map<string, { failures: number; until: number }>;
export type MarketCache = Map<string, { expiresAt: number; promise: Promise<Fetched> }>;

export type MarketDeps = {
	fetchFn?: FetchFn;
	now?: () => number;
	timeoutMs?: number;
	/** Resolve as chaves do dono sob demanda (só é chamado por fontes que precisam de chave). */
	getKeys?: () => Promise<MarketKeys> | MarketKeys;
	cache?: MarketCache;
	health?: MarketHealth;
};

export const createMarketCache = (): MarketCache => new Map();
export const createMarketHealth = (): MarketHealth => new Map();
const sharedCache = createMarketCache();
const sharedHealth = createMarketHealth();

class MarketError extends Error {
	constructor(
		readonly code: MarketFailure,
		message: string,
		readonly retryAfterMs?: number,
	) {
		super(message);
	}
}

/** O que um provedor entrega, já normalizado e validado. */
type Fetched = { value: number; asOf?: number; provider: string; host: string };

type Provider = {
	id: string;
	host: string;
	/** Precisa de chave do dono (senão fica de fora da fila quando não há chave). */
	needsKey?: "brapi";
	fetch: (ctx: ProviderCtx) => Promise<Fetched>;
};
type ProviderCtx = { get: (url: URL, headers?: Record<string, string>) => Promise<unknown>; key?: string };

// ---------------------------------------------------------------- HTTP

async function readJsonCapped(response: Response): Promise<unknown> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > MARKET_MAX_BYTES) {
		await response.body?.cancel().catch(() => undefined);
		throw new MarketError("parse", "a resposta da fonte é grande demais");
	}
	let text = "";
	if (response.body) {
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let total = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done || !value) break;
			total += value.byteLength;
			if (total > MARKET_MAX_BYTES) {
				await reader.cancel().catch(() => undefined);
				throw new MarketError("parse", "a resposta da fonte é grande demais");
			}
			chunks.push(value);
		}
		text = new TextDecoder("utf-8").decode(Buffer.concat(chunks));
	} else {
		text = await response.text();
		if (text.length > MARKET_MAX_BYTES) throw new MarketError("parse", "a resposta da fonte é grande demais");
	}
	try {
		return JSON.parse(text);
	} catch {
		throw new MarketError("parse", "a fonte não devolveu dados no formato esperado");
	}
}

function retryAfterMs(response: Response, now: number): number | undefined {
	const raw = response.headers.get("retry-after");
	if (!raw) return undefined;
	const seconds = Number(raw);
	if (Number.isFinite(seconds)) return Math.min(3_600_000, Math.max(0, seconds * 1000));
	const date = Date.parse(raw);
	return Number.isFinite(date) ? Math.min(3_600_000, Math.max(0, date - now)) : undefined;
}

function makeGet(deps: MarketDeps, clock: () => number): ProviderCtx["get"] {
	const fetchFn: FetchFn = deps.fetchFn ?? ((url, init) => fetch(url, init));
	return async (url, headers) => {
		// Defesa em profundidade: o host é fixo no código; se algo montar outra coisa, nem sai da máquina.
		if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname)) throw new MarketError("network", "endereço de fonte não permitido");
		const signal = AbortSignal.timeout(deps.timeoutMs ?? MARKET_TIMEOUT_MS);
		let response: Response;
		try {
			response = await fetchFn(url.toString(), { method: "GET", redirect: "manual", signal, headers: { "User-Agent": MARKET_UA, Accept: "application/json", ...headers } });
		} catch (error) {
			if (signal.aborted || (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))) throw new MarketError("timeout", "a fonte não respondeu a tempo");
			throw new MarketError("network", "não consegui acessar a fonte");
		}
		if (response.status >= 300 && response.status < 400) {
			await response.body?.cancel().catch(() => undefined);
			throw new MarketError("http", "a fonte redirecionou a chamada (não seguido)");
		}
		if (response.status === 401 || response.status === 403) {
			await response.body?.cancel().catch(() => undefined);
			throw new MarketError("auth", "a fonte recusou a chave de acesso");
		}
		if (response.status === 429) {
			const wait = retryAfterMs(response, clock());
			await response.body?.cancel().catch(() => undefined);
			throw new MarketError("rate_limit", "a fonte atingiu o limite de consultas", wait);
		}
		if (response.status === 404) {
			await response.body?.cancel().catch(() => undefined);
			throw new MarketError("not_found", "a fonte não conhece esse ativo");
		}
		if (response.status < 200 || response.status >= 300) {
			await response.body?.cancel().catch(() => undefined);
			throw new MarketError("http", `a fonte falhou (HTTP ${response.status})`);
		}
		return readJsonCapped(response);
	};
}

// ---------------------------------------------------------------- validação

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Número finito, de número JSON ou de texto decimal com ponto ("5.4321"). Nada de formato localizado. */
function num(value: unknown): number | null {
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value);
	return null;
}

function mustNum(value: unknown, what: string): number {
	const parsed = num(value);
	if (parsed === null) throw new MarketError("parse", `a fonte não trouxe ${what} válido`);
	return parsed;
}

function toMillis(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value < 1e11 ? value * 1000 : value;
	if (typeof value === "string" && value.trim()) {
		const asNumber = Number(value);
		if (Number.isFinite(asNumber)) return asNumber < 1e11 ? asNumber * 1000 : asNumber;
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

// ---------------------------------------------------------------- provedores

const BRAPI_HOST = "brapi.dev";
const AWESOME_HOST = "economia.awesomeapi.com.br";
const MB_HOST = "api.mercadobitcoin.net";
const BINANCE_HOST = "data-api.binance.vision";
const METEO_HOST = "api.open-meteo.com";
const GEO_HOST = "geocoding-api.open-meteo.com";
const ALLOWED_HOSTS = new Set([BRAPI_HOST, AWESOME_HOST, MB_HOST, BINANCE_HOST, METEO_HOST, GEO_HOST]);

/** Testa a chave da brapi com um ticker de verdade (usado ao conectar no Marketplace). */
export async function probeBrapiKey(key: string, deps: MarketDeps = {}): Promise<void> {
	const clock = deps.now ?? Date.now;
	const get = makeGet(deps, clock);
	const fetched = await brapiQuote("PETR4", get, key);
	if (!(fetched.value > 0)) throw new MarketError("parse", "a brapi não devolveu cotação");
}

async function brapiQuote(symbol: string, get: ProviderCtx["get"], key: string): Promise<Fetched> {
	const url = new URL(`https://${BRAPI_HOST}/api/quote/${encodeURIComponent(symbol)}`);
	const data = await get(url, { Authorization: `Bearer ${key}` });
	if (!isRec(data) || !Array.isArray(data.results) || data.results.length === 0) throw new MarketError("not_found", "a brapi não conhece esse ativo");
	const first = data.results[0];
	if (!isRec(first)) throw new MarketError("parse", "a fonte não devolveu dados no formato esperado");
	// A brapi devolve os campos na raiz do item; aceita também o aninhado em `data`.
	const body = isRec(first.data) ? first.data : first;
	const returned = typeof body.symbol === "string" ? body.symbol.toUpperCase() : symbol;
	if (returned !== symbol) throw new MarketError("parse", "a fonte devolveu outro ativo");
	return { value: mustNum(body.regularMarketPrice, "o preço"), asOf: toMillis(body.regularMarketTime), provider: "brapi", host: BRAPI_HOST };
}

const brapiProvider = (symbol: string): Provider => ({ id: "brapi", host: BRAPI_HOST, needsKey: "brapi", fetch: (ctx) => brapiQuote(symbol, ctx.get, ctx.key ?? "") });

async function awesomeFx(pair: string, get: ProviderCtx["get"]): Promise<Fetched> {
	const url = new URL(`https://${AWESOME_HOST}/json/last/${encodeURIComponent(pair)}`);
	const data = await get(url);
	const item = isRec(data) ? data[pair.replace("-", "")] : undefined;
	if (!isRec(item)) throw new MarketError("not_found", "a fonte não conhece esse par de moedas");
	// `bid` é o preço de compra, o mesmo que sites de câmbio mostram como "dólar hoje".
	return { value: mustNum(item.bid, "o câmbio"), asOf: toMillis(item.timestamp), provider: "awesomeapi", host: AWESOME_HOST };
}

async function mercadoBitcoin(symbol: string, get: ProviderCtx["get"]): Promise<Fetched> {
	const url = new URL(`https://${MB_HOST}/api/v4/tickers`);
	url.searchParams.set("symbols", `${symbol}-BRL`);
	const data = await get(url);
	const item = Array.isArray(data) ? data.find((row) => isRec(row) && row.pair === `${symbol}-BRL`) : undefined;
	if (!isRec(item)) throw new MarketError("not_found", "a fonte não conhece essa moeda");
	return { value: mustNum(item.last, "o preço"), asOf: toMillis(item.date), provider: "mercadobitcoin", host: MB_HOST };
}

async function binance(symbol: string, quote: "BRL" | "USD", get: ProviderCtx["get"]): Promise<Fetched> {
	const pair = `${symbol}${quote === "USD" ? "USDT" : "BRL"}`;
	const url = new URL(`https://${BINANCE_HOST}/api/v3/ticker/price`);
	url.searchParams.set("symbol", pair);
	const data = await get(url);
	if (!isRec(data) || data.symbol !== pair) throw new MarketError("not_found", "a fonte não conhece essa moeda");
	// Sem horário no preço: vale como "agora".
	return { value: mustNum(data.price, "o preço"), provider: "binance", host: BINANCE_HOST };
}

const GEO_CACHE_TTL_MS = 7 * 86_400_000;
const geoCache = new Map<string, { at: number; lat: number; lon: number }>();

async function geocode(place: string, get: ProviderCtx["get"], now: number): Promise<{ lat: number; lon: number }> {
	const key = place.toLowerCase();
	const hit = geoCache.get(key);
	if (hit && now - hit.at < GEO_CACHE_TTL_MS) return hit;
	const url = new URL(`https://${GEO_HOST}/v1/search`);
	url.searchParams.set("name", place);
	url.searchParams.set("count", "1");
	url.searchParams.set("language", "pt");
	url.searchParams.set("format", "json");
	const data = await get(url);
	const first = isRec(data) && Array.isArray(data.results) ? data.results[0] : undefined;
	if (!isRec(first)) throw new MarketError("not_found", "não encontrei essa cidade");
	const lat = mustNum(first.latitude, "a latitude");
	const lon = mustNum(first.longitude, "a longitude");
	if (geoCache.size >= 200) geoCache.delete(geoCache.keys().next().value as string);
	geoCache.set(key, { at: now, lat, lon });
	return { lat, lon };
}

const WEATHER_FIELD = { rain_probability: "precipitation_probability_max", rain_mm: "precipitation_sum", temp_max: "temperature_2m_max", temp_min: "temperature_2m_min", wind_max: "wind_speed_10m_max" } as const;

async function openMeteo(source: Extract<AlertMarketSource, { type: "weather" }>, get: ProviderCtx["get"], now: number): Promise<Fetched> {
	const coords = source.lat !== undefined && source.lon !== undefined ? { lat: source.lat, lon: source.lon } : await geocode(source.place ?? "", get, now);
	const field = WEATHER_FIELD[source.metric];
	const url = new URL(`https://${METEO_HOST}/v1/forecast`);
	url.searchParams.set("latitude", String(coords.lat));
	url.searchParams.set("longitude", String(coords.lon));
	url.searchParams.set("daily", field);
	url.searchParams.set("timezone", "auto");
	url.searchParams.set("forecast_days", "3");
	const data = await get(url);
	const daily = isRec(data) && isRec(data.daily) ? data.daily : undefined;
	const series = daily?.[field];
	if (!Array.isArray(series)) throw new MarketError("parse", "a previsão veio sem o dado pedido");
	const value = num(series[source.day === "today" ? 0 : 1]);
	if (value === null) throw new MarketError("parse", "a previsão desse dia ainda não está disponível");
	return { value, provider: "open-meteo", host: METEO_HOST };
}

/** Provedores de cada fonte, na ordem de preferência (o primeiro saudável vence; falha cai para o próximo). */
function providersFor(source: AlertMarketSource, now: number): Provider[] {
	switch (source.type) {
		case "quote":
			return [brapiProvider(source.symbol) /* vaga da bolsai: entra aqui quando houver endpoint/documentação confirmados */];
		case "fx":
			return [{ id: "awesomeapi", host: AWESOME_HOST, fetch: (ctx) => awesomeFx(source.pair, ctx.get) }];
		case "crypto": {
			const binanceProvider: Provider = { id: "binance", host: BINANCE_HOST, fetch: (ctx) => binance(source.symbol, source.quote, ctx.get) };
			if (source.quote === "BRL") return [{ id: "mercadobitcoin", host: MB_HOST, fetch: (ctx) => mercadoBitcoin(source.symbol, ctx.get) }, binanceProvider];
			return [binanceProvider];
		}
		case "weather":
			return [{ id: "open-meteo", host: METEO_HOST, fetch: (ctx) => openMeteo(source, ctx.get, now) }];
	}
}

// ---------------------------------------------------------------- saúde (backoff)

const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 10 * 60_000;

function fingerprint(key: string | undefined): string {
	return key ? createHash("sha256").update(key).digest("hex").slice(0, 8) : "-";
}

const healthKey = (provider: Provider, key: string | undefined) => `${provider.id}:${provider.needsKey ? fingerprint(key) : "-"}`;

function inBackoff(health: MarketHealth, id: string, now: number): boolean {
	const entry = health.get(id);
	return Boolean(entry && entry.until > now);
}

function recordFailure(health: MarketHealth, id: string, error: MarketError, now: number): void {
	const failures = (health.get(id)?.failures ?? 0) + 1;
	// Chave recusada não melhora sozinha: espera mais. 429 respeita o Retry-After do provedor.
	const base = error.code === "auth" ? BACKOFF_MAX_MS : error.retryAfterMs ?? Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 1));
	health.set(id, { failures, until: now + Math.max(base, 1000) });
}

// ---------------------------------------------------------------- cache + leitura

function cacheKey(source: AlertMarketSource): string {
	switch (source.type) {
		case "quote":
			return `quote:${source.symbol}`;
		case "fx":
			return `fx:${source.pair}`;
		case "crypto":
			return `crypto:${source.symbol}:${source.quote}`;
		case "weather":
			return `weather:${source.lat !== undefined ? `${source.lat},${source.lon}` : (source.place ?? "").toLowerCase()}:${source.metric}:${source.day}`;
	}
}

const HINT_NEEDS_KEY = "conecte a brapi no Marketplace (é grátis) para acompanhar cotações";

async function fetchFrom(source: AlertMarketSource, deps: MarketDeps, now: number): Promise<Fetched> {
	const clock = deps.now ?? Date.now;
	const health = deps.health ?? sharedHealth;
	const get = makeGet(deps, clock);
	const providers = providersFor(source, now);
	let keys: MarketKeys = {};
	if (providers.some((provider) => provider.needsKey) && deps.getKeys) keys = (await deps.getKeys()) ?? {};
	// Quem precisa de chave e o dono não tem fica de fora. Sem nenhum provedor possível, falha clara e acionável.
	const eligible = providers.filter((provider) => !provider.needsKey || Boolean(keys[provider.needsKey]));
	if (eligible.length === 0) throw new MarketError("needs_key", HINT_NEEDS_KEY);
	let last: MarketError | null = null;
	for (const provider of eligible) {
		const key = provider.needsKey ? keys[provider.needsKey] : undefined;
		const id = healthKey(provider, key);
		if (inBackoff(health, id, clock())) {
			last ??= new MarketError("network", "a fonte está indisponível no momento; tentarei de novo em instantes");
			continue;
		}
		try {
			const result = await provider.fetch({ get, ...(key ? { key } : {}) });
			health.delete(id);
			return result;
		} catch (error) {
			const typed = error instanceof MarketError ? error : new MarketError("network", "não consegui acessar a fonte");
			// Chave recusada e ativo desconhecido dependem do pedido, não da saúde do serviço: só a chave entra no backoff.
			if (typed.code !== "not_found" && typed.code !== "parse") recordFailure(health, id, typed, clock());
			last = typed;
			// Ativo que o provedor desconhece não melhora trocando de provedor em outra fonte de dados (cripto tem reserva).
			if (typed.code === "not_found" && eligible.length === 1) break;
		}
	}
	throw last ?? new MarketError("network", "não consegui acessar a fonte");
}

function shared(source: AlertMarketSource, deps: MarketDeps, now: number): Promise<Fetched> {
	const cache = deps.cache ?? sharedCache;
	const key = cacheKey(source);
	const hit = cache.get(key);
	if (hit && hit.expiresAt > now) return hit.promise;
	if (cache.size >= CACHE_MAX_ENTRIES) {
		for (const [entryKey, entry] of cache) if (entry.expiresAt <= now) cache.delete(entryKey);
		if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
	}
	const promise = fetchFrom(source, deps, now);
	cache.set(key, { expiresAt: now + MARKET_CACHE_TTL_MS, promise });
	// Falha não fica no cache: a próxima leitura tenta de novo (o backoff do provedor é quem segura o excesso).
	promise.catch(() => {
		if (cache.get(key)?.promise === promise) cache.delete(key);
	});
	return promise;
}

const BRT_OFFSET_MS = 3 * 3_600_000;
const brtDay = (ms: number) => new Date(ms - BRT_OFFSET_MS).toISOString().slice(0, 10);

/**
 * Lê uma fonte de mercado. Nunca lança: falha vira `{ ok: false, code, reason }` com texto simples (pt-BR) que pode
 * ir ao usuário e ao modelo, sem URL nem chave.
 */
export async function readMarketSource(source: AlertMarketSource, deps: MarketDeps = {}): Promise<MarketResult> {
	const clock = deps.now ?? Date.now;
	const started = clock();
	const fail = (error: MarketError, host = `market:${source.type}`): MarketResult => ({ ok: false, code: error.code, reason: error.message, host, ms: clock() - started });
	let fetched: Fetched;
	try {
		// A elegibilidade (chave do dono) é conferida antes do cache: o valor do cache é de todos, o direito de usar o provedor não.
		let resolved: Promise<MarketKeys> | undefined;
		const getKeys = deps.getKeys ? () => (resolved ??= Promise.resolve(deps.getKeys!())) : undefined;
		if (source.type === "quote") {
			const keys = getKeys ? ((await getKeys()) ?? {}) : {};
			if (!keys.brapi) throw new MarketError("needs_key", HINT_NEEDS_KEY);
		}
		fetched = await shared(source, { ...deps, ...(getKeys ? { getKeys } : {}) }, started);
	} catch (error) {
		return fail(error instanceof MarketError ? error : new MarketError("network", "não consegui acessar a fonte"));
	}
	const read = interpret(source, fetched, started);
	if ("error" in read) return fail(read.error, fetched.host);
	return { ok: true, read: read.read, host: fetched.host, ms: clock() - started, provider: fetched.provider };
}

/** Atraso medido e frescor da cotação em relação ao pregão. */
function interpret(source: AlertMarketSource, fetched: Fetched, now: number): { read: AlertRuleRead } | { error: MarketError } {
	const asOf = fetched.asOf;
	const base: AlertRuleRead = { kind: "number", value: fetched.value, ...(asOf !== undefined ? { asOf: new Date(asOf).toISOString() } : {}) };
	if (source.type !== "quote" || asOf === undefined) return { read: base };
	if (now - asOf > QUOTE_STALE_MS) return { error: new MarketError("stale", "a cotação está desatualizada") };
	const session = b3Session(new Date(now));
	if (session.phase === "open") {
		// Passada a primeira hora do pregão a cotação tem de ser de hoje; senão o mercado está fechado (feriado fora da
		// lista, paralisação). Na primeira hora um ativo pouco negociado ainda pode não ter feito o primeiro negócio.
		const sinceOpen = new Date(now).getTime() - Date.parse(`${session.dateKey}T00:00:00-03:00`) - session.schedule.open * 60_000;
		if (sinceOpen > 3_600_000 && brtDay(asOf) !== session.dateKey) return { error: new MarketError("market_closed", "o mercado parece fechado hoje (a cotação é de outro dia)") };
		const minutes = Math.round((now - asOf) / 60_000);
		// Só conta como atraso do provedor o que é plausível (até 2 h); mais que isso é ativo sem negócio recente.
		return { read: { ...base, ...(minutes > 0 && minutes <= 120 ? { delayMinutes: minutes } : {}) } };
	}
	return { read: base };
}
