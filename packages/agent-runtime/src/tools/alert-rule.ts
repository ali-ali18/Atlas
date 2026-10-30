import { readAlertRule } from "@workspace/search";
import { evaluateAlertRule, type AlertRule, type AlertRuleRead, type BotLanguage } from "@workspace/shared";
import { ownerMarketAccess } from "../market/keys.js";

/**
 * Regra de alerta determinística (`propose_routine.alert.rule`): o servidor confere a fonte sozinho, sem modelo.
 * Este módulo tem o schema que o modelo vê e o teste ao vivo da regra na criação: a regra só é gravada se a
 * leitura funcionar agora (nunca grava uma regra que não lê).
 */

/** Leitor injetável (teste e harness); produção lê a fonte de verdade com o guard SSRF de `@workspace/search`. */
export type AlertRuleReader = (rule: AlertRule) => Promise<
	{ ok: true; read: AlertRuleRead; host: string; ms: number } | { ok: false; code: string; reason: string; host: string; ms: number }
>;

export const ALERT_RULE_SCHEMA = {
	type: "object",
	description:
		"Server-checked rule, no model cost per check. Use for an EXACT value or a NEW ITEM on a public page or feed (price, stock text, JSON field, RSS/Atom), or for a ready source with NO link: B3 quote, currency pair, crypto, weather forecast. Do not use when the check needs judgement, a connector, a login or a page that only renders with JavaScript: then use plain `condition`. The rule is read once when you create it; the tool fails if it cannot read the value, so never invent selectors.",
	properties: {
		source: {
			type: "object",
			description: "Where to read. page: url + extract (css selector with optional attribute | jsonpath like $.data.price | regex whose first group is the value). feed: url of an RSS/Atom feed (only with check new_item). Ready sources take NO url (check kind value, parse money or number): quote = B3 stock/FII/ETF/BDR by symbol (needs the user's brapi key from the Marketplace); fx = currency pair; crypto = symbol + quote currency; weather = place (city) + metric + day.",
			properties: {
				type: { type: "string", enum: ["page", "feed", "quote", "fx", "crypto", "weather"] },
				url: { type: "string", description: "page/feed only: public http(s) address." },
				symbol: { type: "string", description: "quote: B3 ticker, e.g. BBAS3, HGLG11. crypto: BTC, ETH." },
				pair: { type: "string", description: "fx: FROM-TO, e.g. USD-BRL (1 USD in BRL)." },
				quote: { type: "string", enum: ["BRL", "USD"], description: "crypto: currency of the price (default BRL)." },
				place: { type: "string", description: "weather: city name, e.g. Curitiba." },
				metric: { type: "string", enum: ["rain_probability", "rain_mm", "temp_max", "temp_min", "wind_max"], description: "weather: what to compare (percent, mm, °C, km/h)." },
				day: { type: "string", enum: ["today", "tomorrow"], description: "weather: relative to each check (default tomorrow)." },
				extract: {
					type: "object",
					properties: {
						kind: { type: "string", enum: ["css", "jsonpath", "regex"] },
						selector: { type: "string", description: "css: selector of the element holding the value (or of each list item for new_item)." },
						attribute: { type: "string", description: "css: read this attribute (e.g. content) instead of the text." },
						path: { type: "string", description: "jsonpath: dot keys and [index] only, e.g. $.data.items[0].price." },
						pattern: { type: "string", description: "regex: max 200 chars, no nested repeats; the first capture group is the value." },
					},
					required: ["kind"],
				},
			},
			required: ["type", "url"],
		},
		check: {
			type: "object",
			description: "kind value: parse number|money|text and op lt|lte|gt|gte|eq|neq|between (value2 = upper bound)|contains (text)|changed_pct (value = percent). kind new_item: notify when a new item appears. value is a plain number (400), never \"R$ 400\".",
			properties: {
				kind: { type: "string", enum: ["value", "new_item"] },
				parse: { type: "string", enum: ["number", "money", "text"] },
				op: { type: "string", enum: ["lt", "lte", "gt", "gte", "eq", "neq", "between", "contains", "changed_pct"] },
				value: { type: ["number", "string"] },
				value2: { type: "number" },
				currency: { type: "string", enum: ["BRL", "USD", "EUR", "GBP"], description: "Only parse money; default follows the language." },
			},
			required: ["kind"],
		},
		label: { type: "string", description: "What is watched, short, in the user's language (e.g. \"tênis Nike Pegasus\"). Shown in the sentence and the notification." },
		message: { type: "string", description: "Optional notification text; only the {value} placeholder is replaced. Omit for the default sentence." },
		intervalMinutes: { type: "number", description: "How often to check, chosen by you for how fast the data really changes (pages 60-240, feeds 30-120, quotes/fx 15-60, crypto 5-30, weather 360). The server only enforces a technical floor (page 30 min, feed 15, quote/fx 15, crypto 5, weather 180) and checks quotes only during the B3 session; it spaces checks out by itself when nothing changes." },
	},
	required: ["source", "check"],
} as const;

const HINTS: Record<string, string> = {
	blocked: "The address is not allowed (only public http(s) sites). Ask the user for the public page.",
	timeout: "The site did not answer in time. Try again later or another source; tell the user plainly if you cannot watch it.",
	http: "The site refused or failed (it may block automated access). Try another source, or fall back to a plain condition checked by the model.",
	network: "The site could not be reached. Check the address or try another source.",
	too_large: "The page is too large to read. Use a lighter source (a JSON endpoint or a feed) or a plain condition.",
	parse: "The source did not have the expected format. Re-check the selector/path or whether this is really a feed, or use a plain condition.",
	needs_key: "Quotes need the user's free brapi key. Call propose_connector with app \"brapi\" so the user connects it in the Marketplace (never ask for the key in chat), then retry. Meanwhile offer a plain condition checked by the model.",
	auth: "The brapi key was refused. Call propose_connector with app \"brapi\" so the user reconnects it in the Marketplace (never ask for the key in chat).",
	rate_limit: "The quote source hit its usage limit. Try again later or use a longer interval; tell the user plainly.",
	not_found: "The source does not know that asset, pair or city. Check the symbol/pair/place with the user (B3 tickers only for quote; do not guess).",
	stale: "The quote is outdated. Try again later or tell the user the source is not updating.",
	market_closed: "The market looks closed today. Create the alert anyway only if the user wants it for later sessions; the current reading is not available.",
};
const NOT_FOUND_HINT = "Try another selector, jsonpath or regex for the value; if the page only shows the value after JavaScript runs or needs a login, use a plain `condition` (checked by the model) instead of a rule.";

/**
 * Lê a regra agora e avalia uma vez. Falha com o motivo e uma dica acionável (texto para o modelo); nunca
 * devolve sucesso falso. `display` é a leitura de agora, já formatada ("R$ 449,90"); para item novo, quantos itens há.
 */
export async function testAlertRule(
	rule: AlertRule,
	locale: BotLanguage,
	reader: AlertRuleReader = (r) => readAlertRule(r),
): Promise<{ display: string; host: string; note?: string }> {
	const result = await reader(rule).catch(() => null);
	if (!result) throw new Error(`Rule test failed: could not read the source. ${HINTS.network}`);
	if (!result.ok) throw new Error(`Rule test failed: ${result.reason}. ${HINTS[result.code] ?? HINTS.network} Do not create the alert with this rule.`);
	const evaluation = evaluateAlertRule({ rule, wasActive: false, read: result.read, now: new Date(), locale });
	if (!evaluation.verdict || evaluation.display === undefined) {
		throw new Error(`Rule test failed: ${evaluation.reason ?? "no value"}. ${NOT_FOUND_HINT} Do not create the alert with this rule.`);
	}
	return { display: evaluation.display, host: result.host, ...(evaluation.note ? { note: evaluation.note } : {}) };
}

/**
 * Leitor de produção para o teste da criação: as fontes de mercado usam a chave do DONO do run (cofre do
 * Marketplace), nunca de ambiente nem de outro usuário.
 */
export function ownerAlertRuleReader(userId: string | undefined): AlertRuleReader {
	return async (rule) => {
		const access = ownerMarketAccess(userId);
		const result = await readAlertRule(rule, { market: { getKeys: access.getKeys } });
		// Chave da brapi recusada (revogada): a conexão do dono vira erro e o cartão de reconexão passa a aparecer.
		await access.afterRead(result);
		return result;
	};
}

/** Frase para o modelo contar ao usuário o que leu (o valor só vem de uma leitura real). */
export function alertRuleReadingNote(rule: AlertRule, display: string, delayNote?: string): string {
	if (rule.check.kind === "new_item") return `The source lists ${display} items right now; only items that appear from now on will notify.`;
	const tail = "Tell the user in one short sentence what it is now and how often you check (no technical terms).";
	const delay = delayNote ? ` The quote is delayed (${delayNote}): say so.` : "";
	switch (rule.source.type) {
		case "quote":
			return `Current reading: ${display} today.${delay} Quotes are only checked during the B3 session and once after the close. ${tail}`;
		case "fx":
			return `Current reading: 1 ${rule.source.pair.split("-")[0]} = ${display} right now. ${tail}`;
		case "weather":
			return `Current forecast: ${display}. The forecast is re-read every few hours. ${tail}`;
		default:
			return `Current reading: ${display}.${delay} ${tail}`;
	}
}
