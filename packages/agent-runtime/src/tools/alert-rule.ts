import { readAlertRule } from "@workspace/search";
import { evaluateAlertRule, type AlertRule, type AlertRuleRead, type BotLanguage } from "@workspace/shared";

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
		"Server-checked rule, no model cost per check. Use for an EXACT value or a NEW ITEM on a public page or feed (price, stock text, JSON field, RSS/Atom). Do not use when the check needs judgement, a connector, a login or a page that only renders with JavaScript: then use plain `condition`. The rule is read once when you create it; the tool fails if it cannot read the value, so never invent selectors.",
	properties: {
		source: {
			type: "object",
			description: "Where to read. type page: url + extract (css selector with optional attribute | jsonpath like $.data.price | regex whose first group is the value). type feed: url of an RSS/Atom feed (only with check new_item).",
			properties: {
				type: { type: "string", enum: ["page", "feed"] },
				url: { type: "string", description: "Public http(s) address." },
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
		intervalMinutes: { type: "number", description: "How often to check, chosen by you for how fast the data really changes (prices/pages 60-240, feeds 30-120). The server only enforces a technical floor (page 30 min, feed 15 min) and spaces checks out by itself when nothing changes." },
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
};
const NOT_FOUND_HINT = "Try another selector, jsonpath or regex for the value; if the page only shows the value after JavaScript runs or needs a login, use a plain `condition` (checked by the model) instead of a rule.";

/**
 * Lê a regra agora e avalia uma vez. Falha com o motivo e uma dica acionável (texto para o modelo); nunca
 * devolve sucesso falso. `display` é a leitura de agora, já formatada ("R$ 449,90"); para item novo, quantos itens há.
 */
export async function testAlertRule(rule: AlertRule, locale: BotLanguage, reader: AlertRuleReader = (r) => readAlertRule(r)): Promise<{ display: string; host: string }> {
	const result = await reader(rule).catch(() => null);
	if (!result) throw new Error(`Rule test failed: could not read the source. ${HINTS.network}`);
	if (!result.ok) throw new Error(`Rule test failed: ${result.reason}. ${HINTS[result.code] ?? HINTS.network} Do not create the alert with this rule.`);
	const evaluation = evaluateAlertRule({ rule, wasActive: false, read: result.read, now: new Date(), locale });
	if (!evaluation.verdict || evaluation.display === undefined) {
		throw new Error(`Rule test failed: ${evaluation.reason ?? "no value"}. ${NOT_FOUND_HINT} Do not create the alert with this rule.`);
	}
	return { display: evaluation.display, host: result.host };
}

/** Frase para o modelo contar ao usuário o que leu (o valor só vem de uma leitura real). */
export function alertRuleReadingNote(rule: AlertRule, display: string): string {
	return rule.check.kind === "new_item"
		? `The source lists ${display} items right now; only items that appear from now on will notify.`
		: `Current reading: ${display}. Tell the user in one short sentence what it is now and how often you check (no technical terms).`;
}
