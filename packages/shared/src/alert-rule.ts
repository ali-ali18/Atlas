/**
 * Regra de alerta determinística: o agente entende o pedido uma vez e grava uma regra em formato fechado;
 * o servidor confere a regra sozinho, sem modelo. Este módulo é o formato (tipos, validação, frase e aviso).
 * A leitura da fonte (I/O) mora em `packages/search`; a avaliação das leituras em `alert-rule-eval.ts`.
 *
 * A união de fontes (`source.type`) é extensível: cotação, câmbio e clima (etapa 2) e conector (etapas 3/5)
 * entram como novos discriminantes. Hoje só `page` e `feed` são implementados.
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

/** Fontes implementadas hoje. Futuras: quote, fx, weather (etapa 2), connector (etapas 3/5). */
export type AlertSource = { type: "page"; url: string; extract: AlertExtract } | { type: "feed"; url: string };
export const ALERT_SOURCE_TYPES = ["page", "feed"] as const;

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
const SOURCE_FLOOR_MINUTES: Record<AlertSource["type"], number> = { page: 30, feed: 15 };
const SOURCE_DEFAULT_MINUTES: Record<AlertSource["type"], number> = { page: 120, feed: 60 };

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

function parseSource(raw: unknown): { source: AlertSource } | { error: string } {
	if (!isRecord(raw)) return { error: `rule.source must be an object (type: ${ALERT_SOURCE_TYPES.join(" | ")})` };
	const type = raw.type;
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
	return { check: { kind: "value", parse, op: typedOp, value, ...(value2 !== undefined ? { value2 } : {}), ...(currency ? { currency } : {}) } };
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

function formatCheckValue(check: Extract<AlertCheck, { kind: "value" }>, which: "value" | "value2", locale: BotLanguage): string {
	const raw = which === "value" ? check.value : check.value2;
	if (typeof raw !== "number") return `“${String(raw ?? "")}”`;
	if (check.op === "changed_pct") return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(raw)}%`;
	return formatAlertNumber(raw, check.parse, locale, check.currency);
}

const OP_SYMBOL: Record<AlertValueOp, string> = { lt: "<", lte: "≤", gt: ">", gte: "≥", eq: "=", neq: "≠", between: "", contains: "∋", changed_pct: "Δ" };

/** "tênis < R$ 400" (curto, para o card). Novo item: "novidade". */
export function describeAlertRuleCompact(rule: AlertRule, locale: BotLanguage): string {
	const label = rule.label ?? "";
	if (rule.check.kind === "new_item") return [label, NEW_ITEM_WORD[locale]].filter(Boolean).join(" · ");
	const check = rule.check;
	const a = formatCheckValue(check, "value", locale);
	const tail = check.op === "between" ? `${a}–${formatCheckValue(check, "value2", locale)}` : check.op === "changed_pct" ? `${OP_SYMBOL.changed_pct} ≥ ${a}` : `${OP_SYMBOL[check.op]} ${a}`;
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
			.replace("{a}", formatCheckValue(check, "value", locale))
			.replace("{b}", check.op === "between" ? formatCheckValue(check, "value2", locale) : "");
		text = `${rule.label ?? DEFAULT_LABEL[locale] ?? "o valor"} ${phrase}`;
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
	if (rule.check.kind === "new_item") return NEW_ITEM_TEMPLATE[lang]!.replace("{label}", rule.label ?? DEFAULT_SOURCE_LABEL[locale] ?? "a fonte");
	return STATUS_TEMPLATE[lang]!.replace("{Label}", capitalize(rule.label ?? DEFAULT_LABEL[locale] ?? "o valor"));
}

/** Aviso final: o modelo da regra (ou o padrão do idioma) com {value} trocado pela leitura. Nenhuma outra interpolação. */
export function renderAlertMessage(rule: AlertRule, value: string, locale: BotLanguage): string {
	const template = rule.message ?? defaultAlertMessage(rule, locale);
	return template.split("{value}").join(value).slice(0, 300);
}
