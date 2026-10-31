/**
 * Regra de alerta determinística: o agente entende o pedido uma vez e grava uma regra em formato fechado;
 * o servidor confere a regra sozinho, sem modelo. Este módulo é o formato (tipos, validação, frase e aviso).
 * A leitura da fonte (I/O) mora em `packages/search`; a avaliação das leituras em `alert-rule-eval.ts`.
 *
 * A união de fontes (`source.type`) é extensível. Páginas e feeds trazem uma URL; as fontes de mercado (etapa 2:
 * cotação, câmbio, cripto e clima) NÃO têm URL: o servidor monta a chamada a partir de campos fechados e de
 * provedores com host fixo (nunca uma URL vinda do modelo). Conector entra nas etapas 3/5.
 */
import type { BotLanguage } from "./bot-language.js";
import { ALERT_JSONPATH_MAX, ALERT_REGEX_MAX, parseJsonPath, unsafeRegexReason } from "./alert-rule-extract.js";

export const ALERT_RULE_URL_MAX = 2000;
export const ALERT_SELECTOR_MAX = 200;
export const ALERT_ATTRIBUTE_MAX = 50;
export const ALERT_LABEL_MAX = 60;
export const ALERT_MESSAGE_MAX = 200;
export const ALERT_TEXT_VALUE_MAX = 200;
export const ALERT_RULE_INTERVAL_MAX = 1440;

export type AlertExtract =
	| { kind: "css"; selector: string; attribute?: string }
	| { kind: "jsonpath"; path: string }
	| { kind: "regex"; pattern: string };

export const ALERT_WEATHER_METRICS = ["rain_probability", "rain_mm", "temp_max", "temp_min", "wind_max"] as const;
export type AlertWeatherMetric = (typeof ALERT_WEATHER_METRICS)[number];
export const ALERT_WEATHER_DAYS = ["today", "tomorrow"] as const;
export type AlertWeatherDay = (typeof ALERT_WEATHER_DAYS)[number];
export const ALERT_CRYPTO_QUOTES = ["BRL", "USD"] as const;
export type AlertCryptoQuote = (typeof ALERT_CRYPTO_QUOTES)[number];
/** Moedas aceitas no par de câmbio (códigos ISO). */
export const ALERT_FX_CURRENCIES = ["USD", "EUR", "GBP", "BRL", "ARS", "JPY", "CAD", "AUD", "CHF", "CNY", "MXN", "CLP", "COP", "UYU", "PYG"] as const;
export const ALERT_PLACE_MAX = 80;

/** Fontes implementadas hoje. Futura: connector (etapas 3/5). */
export type AlertSource =
	| { type: "page"; url: string; extract: AlertExtract }
	| { type: "feed"; url: string }
	/** Ação, FII, ETF ou BDR da B3 pelo código ("BBAS3"). */
	| { type: "quote"; symbol: string }
	/** Par de moedas "USD-BRL" (1 USD vale quantos BRL). */
	| { type: "fx"; pair: string }
	/** Cripto: símbolo ("BTC") cotado em BRL ou USD. */
	| { type: "crypto"; symbol: string; quote: AlertCryptoQuote }
	/** Previsão por cidade (ou coordenadas) para hoje ou amanhã, relativo a cada conferência. */
	| { type: "weather"; place?: string; lat?: number; lon?: number; metric: AlertWeatherMetric; day: AlertWeatherDay };
export type AlertSourceType = AlertSource["type"];
export const ALERT_SOURCE_TYPES = ["page", "feed", "quote", "fx", "crypto", "weather"] as const;
/** Fonte sem URL: o servidor monta a chamada a provedores de host fixo. */
export type AlertMarketSource = Exclude<AlertSource, { type: "page" } | { type: "feed" }>;
export function isMarketAlertSource(source: AlertSource): source is AlertMarketSource {
	return source.type !== "page" && source.type !== "feed";
}

export const ALERT_VALUE_OPS = ["lt", "lte", "gt", "gte", "eq", "neq", "between", "contains", "changed_pct"] as const;
export type AlertValueOp = (typeof ALERT_VALUE_OPS)[number];
export const ALERT_PARSE_KINDS = ["number", "money", "text"] as const;
export type AlertParseKind = (typeof ALERT_PARSE_KINDS)[number];
export const ALERT_CURRENCIES = ["BRL", "USD", "EUR", "GBP"] as const;
export type AlertCurrency = (typeof ALERT_CURRENCIES)[number];

export type AlertCheck =
	| { kind: "value"; parse: AlertParseKind; op: AlertValueOp; value: number | string; value2?: number; currency?: AlertCurrency }
	| { kind: "new_item" };

export type AlertRule = {
	source: AlertSource;
	check: AlertCheck;
	/** O que está sendo vigiado, curto, no idioma do usuário ("tênis Nike Pegasus"). Entra na frase e no aviso. */
	label?: string;
	/** Modelo do aviso; só o marcador {value} é substituído. Ausente = frase padrão do idioma. */
	message?: string;
	/** Frequência escolhida pelo agente (minutos), já ajustada ao piso técnico da fonte. */
	intervalMinutes?: number;
};

export type ParseAlertRuleResult = { ok: true; rule: AlertRule } | { ok: false; error: string };

/** Piso técnico por fonte: protege sites de terceiros e cotas de API. Não é um mínimo de produto. */
const SOURCE_FLOOR_MINUTES: Record<AlertSource["type"], number> = { page: 30, feed: 15, quote: 15, fx: 15, crypto: 5, weather: 180 };
const SOURCE_DEFAULT_MINUTES: Record<AlertSource["type"], number> = { page: 120, feed: 60, quote: 30, fx: 30, crypto: 15, weather: 360 };

export function alertSourceFloorMinutes(source: Pick<AlertSource, "type">): number {
	return SOURCE_FLOOR_MINUTES[source.type];
}

export function defaultAlertRuleInterval(source: Pick<AlertSource, "type">): number {
	return SOURCE_DEFAULT_MINUTES[source.type];
}

/** Frequência dentro do piso da fonte e do máximo de 1 dia. */
export function clampAlertRuleInterval(minutes: number, source: Pick<AlertSource, "type">): number {
	const value = Number.isFinite(minutes) ? Math.round(minutes) : defaultAlertRuleInterval(source);
	return Math.min(ALERT_RULE_INTERVAL_MAX, Math.max(alertSourceFloorMinutes(source), value));
}

const RULE_FIELDS = ["source", "check", "label", "message", "intervalMinutes"] as const;
const PAGE_FIELDS = ["type", "url", "extract"] as const;
const FEED_FIELDS = ["type", "url"] as const;
const EXTRACT_FIELDS = { css: ["kind", "selector", "attribute"], jsonpath: ["kind", "path"], regex: ["kind", "pattern"] } as const;
const VALUE_FIELDS = ["kind", "parse", "op", "value", "value2", "currency"] as const;
const NEW_ITEM_FIELDS = ["kind"] as const;
const QUOTE_FIELDS = ["type", "symbol"] as const;
const FX_FIELDS = ["type", "pair"] as const;
const CRYPTO_FIELDS = ["type", "symbol", "quote"] as const;
const WEATHER_FIELDS = ["type", "place", "lat", "lon", "metric", "day"] as const;

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function unknownField(row: Rec, allowed: readonly string[], where: string): string | null {
	const extra = Object.keys(row).find((key) => !allowed.includes(key));
	return extra ? `unknown field "${extra}" in ${where} (accepted: ${allowed.join(", ")})` : null;
}

function oneLine(value: unknown): string {
	return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function parseUrl(raw: unknown, where: string): { url: string } | { error: string } {
	const text = oneLine(raw);
	if (!text) return { error: `${where}.url is required (a public http(s) address)` };
	if (text.length > ALERT_RULE_URL_MAX) return { error: `${where}.url is longer than ${ALERT_RULE_URL_MAX} characters` };
	let parsed: URL;
	try {
		parsed = new URL(text);
	} catch {
		return { error: `${where}.url is not a valid address` };
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { error: `${where}.url must be http or https` };
	if (parsed.username || parsed.password) return { error: `${where}.url must not contain credentials` };
	parsed.hash = "";
	return { url: parsed.toString() };
}

function parseExtract(raw: unknown): { extract: AlertExtract } | { error: string } {
	if (!isRecord(raw)) return { error: `rule.source.extract must be an object (kind: css | jsonpath | regex)` };
	const kind = raw.kind;
	if (kind !== "css" && kind !== "jsonpath" && kind !== "regex") return { error: `rule.source.extract.kind must be one of: css, jsonpath, regex` };
	const unknown = unknownField(raw, EXTRACT_FIELDS[kind], `rule.source.extract (${kind})`);
	if (unknown) return { error: unknown };
	if (kind === "css") {
		const selector = oneLine(raw.selector);
		if (!selector) return { error: "rule.source.extract.selector is required" };
		if (selector.length > ALERT_SELECTOR_MAX) return { error: `rule.source.extract.selector is longer than ${ALERT_SELECTOR_MAX} characters` };
		if (raw.attribute !== undefined && raw.attribute !== null) {
			const attribute = oneLine(raw.attribute);
			if (!/^[A-Za-z_:][\w:.-]*$/.test(attribute) || attribute.length > ALERT_ATTRIBUTE_MAX) return { error: "rule.source.extract.attribute must be a plain attribute name (e.g. content, data-price)" };
			return { extract: { kind, selector, attribute } };
		}
		return { extract: { kind, selector } };
	}
	if (kind === "jsonpath") {
		const path = oneLine(raw.path);
		if (!path || path.length > ALERT_JSONPATH_MAX || !parseJsonPath(path)) return { error: 'rule.source.extract.path must be a simple JSON path such as $.data.price or $.items[0].value (dot keys, [index], ["key"] only)' };
		return { extract: { kind, path } };
	}
	const pattern = typeof raw.pattern === "string" ? raw.pattern.trim() : "";
	const reason = unsafeRegexReason(pattern);
	if (reason) return { error: `rule.source.extract.pattern rejected: ${reason} (max ${ALERT_REGEX_MAX} characters; the first capture group is the value)` };
	return { extract: { kind, pattern } };
}

function parseMarketSource(raw: Rec, type: "quote" | "fx" | "crypto" | "weather"): { source: AlertSource } | { error: string } {
	if (type === "quote") {
		const unknown = unknownField(raw, QUOTE_FIELDS, "rule.source (quote)");
		if (unknown) return { error: unknown };
		const symbol = oneLine(raw.symbol).toUpperCase();
		if (!/^[A-Z]{4}\d{1,2}$/.test(symbol)) return { error: 'rule.source.symbol must be a B3 ticker such as BBAS3, PETR4, HGLG11, BOVA11 or AAPL34 (stocks, FIIs, ETFs and BDRs only)' };
		return { source: { type, symbol } };
	}
	if (type === "fx") {
		const unknown = unknownField(raw, FX_FIELDS, "rule.source (fx)");
		if (unknown) return { error: unknown };
		const pair = oneLine(raw.pair).toUpperCase().replace("/", "-");
		const [from, to] = pair.split("-");
		const known = (code: string | undefined) => ALERT_FX_CURRENCIES.includes(code as (typeof ALERT_FX_CURRENCIES)[number]);
		if (pair.split("-").length !== 2 || !known(from) || !known(to) || from === to) return { error: `rule.source.pair must be two different currencies like USD-BRL (accepted: ${ALERT_FX_CURRENCIES.join(", ")})` };
		return { source: { type, pair } };
	}
	if (type === "crypto") {
		const unknown = unknownField(raw, CRYPTO_FIELDS, "rule.source (crypto)");
		if (unknown) return { error: unknown };
		const symbol = oneLine(raw.symbol).toUpperCase();
		if (!/^[A-Z0-9]{2,10}$/.test(symbol)) return { error: "rule.source.symbol must be a crypto symbol such as BTC, ETH or SOL" };
		const quote = raw.quote === undefined ? "BRL" : raw.quote;
		if (!ALERT_CRYPTO_QUOTES.includes(quote as AlertCryptoQuote)) return { error: `rule.source.quote must be one of: ${ALERT_CRYPTO_QUOTES.join(", ")}` };
		return { source: { type, symbol, quote: quote as AlertCryptoQuote } };
	}
	const unknown = unknownField(raw, WEATHER_FIELDS, "rule.source (weather)");
	if (unknown) return { error: unknown };
	if (!ALERT_WEATHER_METRICS.includes(raw.metric as AlertWeatherMetric)) return { error: `rule.source.metric must be one of: ${ALERT_WEATHER_METRICS.join(", ")}` };
	const day = raw.day === undefined ? "tomorrow" : raw.day;
	if (!ALERT_WEATHER_DAYS.includes(day as AlertWeatherDay)) return { error: `rule.source.day must be one of: ${ALERT_WEATHER_DAYS.join(", ")}` };
	const place = oneLine(raw.place);
	const hasCoords = raw.lat !== undefined || raw.lon !== undefined;
	if (hasCoords) {
		const lat = raw.lat;
		const lon = raw.lon;
		if (typeof lat !== "number" || typeof lon !== "number" || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return { error: "rule.source.lat and lon must both be valid coordinates" };
		if (place.length > ALERT_PLACE_MAX) return { error: `rule.source.place is longer than ${ALERT_PLACE_MAX} characters` };
		return { source: { type, ...(place ? { place } : {}), lat: Math.round(lat * 1e4) / 1e4, lon: Math.round(lon * 1e4) / 1e4, metric: raw.metric as AlertWeatherMetric, day: day as AlertWeatherDay } };
	}
	if (!place || place.length > ALERT_PLACE_MAX || /[<>{}]/.test(place)) return { error: `rule.source.place is required (a city name, up to ${ALERT_PLACE_MAX} characters) unless lat and lon are given` };
	return { source: { type, place, metric: raw.metric as AlertWeatherMetric, day: day as AlertWeatherDay } };
}

function parseSource(raw: unknown): { source: AlertSource } | { error: string } {
	if (!isRecord(raw)) return { error: `rule.source must be an object (type: ${ALERT_SOURCE_TYPES.join(" | ")})` };
	const type = raw.type;
	if (type === "quote" || type === "fx" || type === "crypto" || type === "weather") return parseMarketSource(raw, type);
	if (type !== "page" && type !== "feed") return { error: `rule.source.type must be one of: ${ALERT_SOURCE_TYPES.join(", ")}` };
	const unknown = unknownField(raw, type === "page" ? PAGE_FIELDS : FEED_FIELDS, `rule.source (${type})`);
	if (unknown) return { error: unknown };
	const url = parseUrl(raw.url, "rule.source");
	if ("error" in url) return url;
	if (type === "feed") return { source: { type, url: url.url } };
	const extract = parseExtract(raw.extract);
	if ("error" in extract) return extract;
	return { source: { type, url: url.url, extract: extract.extract } };
}

const NUMERIC_OPS: readonly AlertValueOp[] = ["lt", "lte", "gt", "gte", "eq", "neq", "between", "changed_pct"];
const TEXT_OPS: readonly AlertValueOp[] = ["eq", "neq", "contains"];

function finiteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e12 ? value : null;
}

function parseCheck(raw: unknown, source: AlertSource): { check: AlertCheck } | { error: string } {
	if (!isRecord(raw)) return { error: "rule.check must be an object (kind: value | new_item)" };
	if (raw.kind === "new_item") {
		const unknown = unknownField(raw, NEW_ITEM_FIELDS, "rule.check (new_item)");
		if (unknown) return { error: unknown };
		if (isMarketAlertSource(source)) return { error: `a ${source.type} source only supports check value (compare the number)` };
		const listable = source.type === "feed" || (source.type === "page" && source.extract.kind === "css");
		if (!listable) return { error: "check new_item needs a feed source, or a page source with a css extract that matches the list of items" };
		return { check: { kind: "new_item" } };
	}
	if (raw.kind !== "value") return { error: "rule.check.kind must be one of: value, new_item" };
	const unknown = unknownField(raw, VALUE_FIELDS, "rule.check (value)");
	if (unknown) return { error: unknown };
	if (source.type === "feed") return { error: "a feed source only supports check new_item" };
	const parse = raw.parse;
	if (parse !== "number" && parse !== "money" && parse !== "text") return { error: `rule.check.parse must be one of: ${ALERT_PARSE_KINDS.join(", ")}` };
	if (isMarketAlertSource(source)) {
		if (parse === "text") return { error: `a ${source.type} source gives a number: use parse ${source.type === "weather" ? "number" : "money"}` };
		if (source.type === "weather" && parse === "money") return { error: "a weather source gives a number (percent, mm, °C or km/h): use parse number" };
		if (raw.currency !== undefined && marketSourceCurrency(source) !== raw.currency) return { error: `rule.check.currency for this source must be ${marketSourceCurrency(source) ?? "omitted"} (the currency the value is quoted in)` };
	}
	const op = raw.op;
	const allowedOps = parse === "text" ? TEXT_OPS : NUMERIC_OPS;
	if (typeof op !== "string" || !allowedOps.includes(op as AlertValueOp)) return { error: `rule.check.op for parse ${parse} must be one of: ${allowedOps.join(", ")}` };
	const typedOp = op as AlertValueOp;
	if (parse === "text") {
		if (raw.value2 !== undefined) return { error: "rule.check.value2 is only for op between" };
		if (raw.currency !== undefined) return { error: "rule.check.currency is only for parse money" };
		const value = oneLine(raw.value);
		if (!value || value.length > ALERT_TEXT_VALUE_MAX) return { error: `rule.check.value must be text of 1 to ${ALERT_TEXT_VALUE_MAX} characters` };
		return { check: { kind: "value", parse, op: typedOp, value } };
	}
	const value = finiteNumber(raw.value);
	if (value === null) return { error: "rule.check.value must be a finite number (use a plain number such as 400 or 12.5, not a string with currency)" };
	if (typedOp === "changed_pct" && (value <= 0 || value > 1000)) return { error: "rule.check.value for changed_pct is a percentage between 0 and 1000 (exclusive of 0)" };
	let value2: number | undefined;
	if (typedOp === "between") {
		const upper = finiteNumber(raw.value2);
		if (upper === null || upper < value) return { error: "rule.check.value2 is required for op between and must be >= value" };
		value2 = upper;
	} else if (raw.value2 !== undefined) {
		return { error: "rule.check.value2 is only for op between" };
	}
	let currency: AlertCurrency | undefined;
	if (raw.currency !== undefined) {
		if (parse !== "money") return { error: "rule.check.currency is only for parse money" };
		if (!ALERT_CURRENCIES.includes(raw.currency as AlertCurrency)) return { error: `rule.check.currency must be one of: ${ALERT_CURRENCIES.join(", ")}` };
		currency = raw.currency as AlertCurrency;
	}
	// Fonte de mercado: o dinheiro vem na moeda da própria cotação (R$ para BBAS3, US$ para EUR-USD…).
	if (isMarketAlertSource(source) && parse === "money" && !currency) currency = marketSourceCurrency(source);
	if (isMarketAlertSource(source) && parse === "money" && !currency) return { error: "this pair is not quoted in BRL, USD, EUR or GBP: use parse number" };
	return { check: { kind: "value", parse, op: typedOp, value, ...(value2 !== undefined ? { value2 } : {}), ...(currency ? { currency } : {}) } };
}

/** Moeda em que a fonte de mercado cota o valor (undefined = não é dinheiro conhecido). */
export function marketSourceCurrency(source: AlertSource): AlertCurrency | undefined {
	let code: string | undefined;
	if (source.type === "quote") code = "BRL";
	else if (source.type === "fx") code = source.pair.split("-")[1];
	else if (source.type === "crypto") code = source.quote;
	return ALERT_CURRENCIES.find((item) => item === code);
}

/** Unidade do número de uma fonte de clima ("%", "mm", "°C", "km/h"); vazio nas demais. */
export function alertSourceUnit(source: AlertSource): string {
	if (source.type !== "weather") return "";
	switch (source.metric) {
		case "rain_probability":
			return "%";
		case "rain_mm":
			return "mm";
		case "wind_max":
			return "km/h";
		default:
			return "°C";
	}
}

/** Nome curto padrão quando o agente não deu `label`: "BBAS3", "USD/BRL", "BTC", "Curitiba". */
export function alertSourceDefaultLabel(source: AlertSource): string | undefined {
	switch (source.type) {
		case "quote":
			return source.symbol;
		case "fx":
			return source.pair.replace("-", "/");
		case "crypto":
			return source.symbol;
		case "weather":
			return source.place;
		default:
			return undefined;
	}
}

/** Só `{value}` é substituído; qualquer outra chave é recusada (nada de interpolação). */
export function validateAlertMessage(message: string): string | null {
	if (message.length > ALERT_MESSAGE_MAX) return `rule.message is longer than ${ALERT_MESSAGE_MAX} characters`;
	if (/[{}]/.test(message.replace(/\{value\}/g, ""))) return "rule.message may only use the {value} placeholder";
	return null;
}

/** Valida e normaliza a regra proposta pelo agente. Campo desconhecido = erro com a lista do que é aceito. */
export function parseAlertRule(raw: unknown): ParseAlertRuleResult {
	if (!isRecord(raw)) return { ok: false, error: "rule must be an object with source and check" };
	const unknown = unknownField(raw, RULE_FIELDS, "rule");
	if (unknown) return { ok: false, error: unknown };
	const source = parseSource(raw.source);
	if ("error" in source) return { ok: false, error: source.error };
	const check = parseCheck(raw.check, source.source);
	if ("error" in check) return { ok: false, error: check.error };
	const label = oneLine(raw.label);
	if (raw.label !== undefined && raw.label !== null && (typeof raw.label !== "string" || label.length > ALERT_LABEL_MAX || /[{}]/.test(label))) return { ok: false, error: `rule.label must be plain text up to ${ALERT_LABEL_MAX} characters, without braces` };
	let message: string | undefined;
	if (raw.message !== undefined && raw.message !== null) {
		message = oneLine(raw.message);
		const problem = message ? validateAlertMessage(message) : null;
		if (problem) return { ok: false, error: problem };
	}
	let intervalMinutes: number | undefined;
	if (raw.intervalMinutes !== undefined && raw.intervalMinutes !== null) {
		if (typeof raw.intervalMinutes !== "number" || !Number.isFinite(raw.intervalMinutes) || raw.intervalMinutes < 1) return { ok: false, error: "rule.intervalMinutes must be a positive number of minutes" };
		intervalMinutes = clampAlertRuleInterval(raw.intervalMinutes, source.source);
	}
	return {
		ok: true,
		rule: {
			source: source.source,
			check: check.check,
			...(label ? { label } : {}),
			...(message ? { message } : {}),
			...(intervalMinutes !== undefined ? { intervalMinutes } : {}),
		},
	};
}

/** Igualdade estrutural (a regra mudou? então o estado de leitura recomeça). */
export function sameAlertRule(a: AlertRule | undefined, b: AlertRule | undefined): boolean {
	return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Host da fonte, para log: nunca a URL inteira (pode carregar chave na query). */
export function alertSourceHost(source: AlertSource): string {
	if (isMarketAlertSource(source)) return `market:${source.type}`;
	try {
		return new URL(source.url).hostname;
	} catch {
		return "?";
	}
}

// ---------------------------------------------------------------- frases

const DEFAULT_CURRENCY: Record<BotLanguage, AlertCurrency> = { "pt-BR": "BRL", "en-US": "USD", "es-ES": "EUR" } as Record<BotLanguage, AlertCurrency>;

export function formatAlertNumber(value: number, parse: AlertParseKind, locale: BotLanguage, currency?: AlertCurrency): string {
	const format =
		parse === "money"
			? new Intl.NumberFormat(locale, { style: "currency", currency: currency ?? DEFAULT_CURRENCY[locale] ?? "BRL" })
			: new Intl.NumberFormat(locale, { maximumFractionDigits: 4 });
	// Espaço comum no lugar do inseparável: o texto vai para push e conversa.
	return format.format(value).replace(/[\u00a0\u202f]/g, " ");
}

function formatCheckValue(check: Extract<AlertCheck, { kind: "value" }>, which: "value" | "value2", locale: BotLanguage, source?: AlertSource): string {
	const raw = which === "value" ? check.value : check.value2;
	if (typeof raw !== "number") return `“${String(raw ?? "")}”`;
	if (check.op === "changed_pct") return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(raw)}%`;
	return formatAlertNumber(raw, check.parse, locale, check.currency) + (source ? alertSourceUnit(source) : "");
}

/** Rótulo mostrado ao usuário: o do agente ou, nas fontes de mercado, o código do ativo. */
function ruleLabel(rule: AlertRule): string | undefined {
	return rule.label ?? alertSourceDefaultLabel(rule.source);
}

const OP_SYMBOL: Record<AlertValueOp, string> = { lt: "<", lte: "≤", gt: ">", gte: "≥", eq: "=", neq: "≠", between: "", contains: "∋", changed_pct: "Δ" };

/** "tênis < R$ 400" (curto, para o card). Novo item: "novidade". */
export function describeAlertRuleCompact(rule: AlertRule, locale: BotLanguage): string {
	const label = ruleLabel(rule) ?? "";
	if (rule.check.kind === "new_item") return [label, NEW_ITEM_WORD[locale]].filter(Boolean).join(" · ");
	const check = rule.check;
	const a = formatCheckValue(check, "value", locale, rule.source);
	const tail = check.op === "between" ? `${a}–${formatCheckValue(check, "value2", locale, rule.source)}` : check.op === "changed_pct" ? `${OP_SYMBOL.changed_pct} ≥ ${a}` : `${OP_SYMBOL[check.op]} ${a}`;
	return `${label ? `${label} ` : ""}${tail}`.trim();
}

const NEW_ITEM_WORD: Record<BotLanguage, string> = { "pt-BR": "novidade", "en-US": "new item", "es-ES": "novedad" } as Record<BotLanguage, string>;
const DEFAULT_LABEL: Record<BotLanguage, string> = { "pt-BR": "o valor", "en-US": "the value", "es-ES": "el valor" } as Record<BotLanguage, string>;
const DEFAULT_SOURCE_LABEL: Record<BotLanguage, string> = { "pt-BR": "a fonte", "en-US": "the source", "es-ES": "la fuente" } as Record<BotLanguage, string>;

type OpPhrases = Record<AlertValueOp, string>;
const PHRASES: Record<string, OpPhrases> = {
	"pt-BR": { lt: "ficar abaixo de {a}", lte: "ficar em {a} ou menos", gt: "passar de {a}", gte: "chegar a {a} ou mais", eq: "for igual a {a}", neq: "for diferente de {a}", between: "ficar entre {a} e {b}", contains: "contiver {a}", changed_pct: "variar {a} ou mais" },
	"en-US": { lt: "drops below {a}", lte: "is {a} or less", gt: "goes above {a}", gte: "reaches {a} or more", eq: "equals {a}", neq: "differs from {a}", between: "is between {a} and {b}", contains: "contains {a}", changed_pct: "changes by {a} or more" },
	"es-ES": { lt: "baje de {a}", lte: "esté en {a} o menos", gt: "pase de {a}", gte: "llegue a {a} o más", eq: "sea igual a {a}", neq: "sea distinto de {a}", between: "esté entre {a} y {b}", contains: "contenga {a}", changed_pct: "varíe {a} o más" },
};
const NEW_ITEM_PHRASE: Record<string, string> = { "pt-BR": "surgir um item novo em {label}", "en-US": "a new item shows up in {label}", "es-ES": "aparezca un elemento nuevo en {label}" };

/** Frase que completa "avisa se …", gerada da regra (a condição em linguagem natural que a UI e os filtros já usam). */
export function describeAlertRuleCondition(rule: AlertRule, locale: BotLanguage): string {
	const lang = PHRASES[locale] ? locale : "pt-BR";
	let text: string;
	if (rule.check.kind === "new_item") {
		text = NEW_ITEM_PHRASE[lang]!.replace("{label}", rule.label ?? DEFAULT_SOURCE_LABEL[locale] ?? "a fonte");
	} else {
		const check = rule.check;
		const phrase = PHRASES[lang]![check.op]
			.replace("{a}", formatCheckValue(check, "value", locale, rule.source))
			.replace("{b}", check.op === "between" ? formatCheckValue(check, "value2", locale, rule.source) : "");
		text = `${ruleLabel(rule) ?? DEFAULT_LABEL[locale] ?? "o valor"} ${phrase}`;
	}
	return text.length > 300 ? `${text.slice(0, 299).trimEnd()}…` : text;
}

const STATUS_TEMPLATE: Record<string, string> = { "pt-BR": "{Label} está em {value}", "en-US": "{Label} is now {value}", "es-ES": "{Label} está en {value}" };
const NEW_ITEM_TEMPLATE: Record<string, string> = { "pt-BR": "Novidade em {label}: {value}", "en-US": "New in {label}: {value}", "es-ES": "Novedad en {label}: {value}" };

function capitalize(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Modelo padrão do aviso, por idioma, já com o rótulo; o marcador {value} fica para `renderAlertMessage`. */
export function defaultAlertMessage(rule: AlertRule, locale: BotLanguage): string {
	const lang = STATUS_TEMPLATE[locale] ? locale : "pt-BR";
	if (rule.check.kind === "new_item") return NEW_ITEM_TEMPLATE[lang]!.replace("{label}", ruleLabel(rule) ?? DEFAULT_SOURCE_LABEL[locale] ?? "a fonte");
	return STATUS_TEMPLATE[lang]!.replace("{Label}", capitalize(ruleLabel(rule) ?? DEFAULT_LABEL[locale] ?? "o valor"));
}

/** Aviso final: o modelo da regra (ou o padrão do idioma) com {value} trocado pela leitura. Nenhuma outra interpolação. */
export function renderAlertMessage(rule: AlertRule, value: string, locale: BotLanguage): string {
	const template = rule.message ?? defaultAlertMessage(rule, locale);
	return template.split("{value}").join(value).slice(0, 300);
}
