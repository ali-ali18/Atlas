/**
 * Avaliação determinística de uma leitura de alerta com regra. Puro: recebe a regra, o estado anterior e o que
 * a fonte devolveu; devolve o veredito (no formato que `decideAlertNotification` já entende) e o estado novo.
 *
 * Proteções contra aviso falso ou repetido:
 * - debounce: só avisa depois de 2 leituras seguidas em que a condição vale;
 * - avisa uma vez e só rearma quando o valor sai da condição com folga (0,5%), para não repetir com o valor oscilando;
 * - valor ilegível, vazio, de outro tipo ou absurdo = sem veredito (nada de aviso falso);
 * - salto brusco (>60%) é suspeito: só vale se a leitura seguinte confirmar;
 * - item novo por identidade estável (guid/link/hash do título) com conjunto de vistos limitado.
 */
import type { BotLanguage } from "./bot-language.js";
import { alertItemKey, quoteAlertExternalText, sanitizeAlertExternalText, type AlertFeedItem, parseLocalizedNumber } from "./alert-rule-extract.js";
import { alertSourceUnit, formatAlertNumber, renderAlertMessage, type AlertCheck, type AlertRule } from "./alert-rule.js";
import type { AlertVerdict } from "./routine-alert.js";

/** Leituras seguidas com a condição valendo antes do primeiro aviso. */
export const ALERT_DEBOUNCE_READS = 2;
/** Folga para rearmar (fração do limite): o valor precisa passar do limite por isso antes de "voltar ao normal". */
export const ALERT_HYSTERESIS = 0.005;
/** Variação entre leituras acima disso é suspeita (loja mudou o layout, pegou outro número). */
export const ALERT_SUSPECT_JUMP = 0.6;
/** Duas leituras suspeitas dentro desta distância confirmam uma à outra. */
export const ALERT_SUSPECT_CONFIRM = 0.05;
export const ALERT_SEEN_IDS_MAX = 200;
const ABSURD_MAX = 1e12;

/** Estado da leitura da regra (vive em `alertJson.ruleState`). `armed` = `!alert.active`. */
export type AlertRuleState = {
	/** Última leitura aceita. */
	lastValue?: number | string;
	lastReadAt?: string;
	/** Leituras seguidas em que a condição valeu (debounce). */
	consecutive?: number;
	/** Leitura brusca esperando confirmação. */
	suspect?: { value: number };
	/** Base de comparação do `changed_pct`. */
	baseline?: number;
	/** Itens já vistos (novo item), limitado. */
	seenIds?: string[];
	seeded?: boolean;
	/** Atraso medido da última cotação (10 a 45 min): o cartão mostra "atraso ~30 min". */
	delayMinutes?: number;
	/** Horário (ISO) do último negócio quando o atraso passa de ~45 min (ativo pouco negociado): "último negócio às 14:32". */
	lastTradeAt?: string;
};

/** O que a fonte devolveu. */
export type AlertRuleRead =
	| { kind: "text"; text: string | null }
	/** Número já lido por um provedor de mercado (sem texto para interpretar). `delayMinutes` = atraso medido da cotação. */
	| { kind: "number"; value: number; asOf?: string; delayMinutes?: number }
	| { kind: "items"; items: Array<Pick<AlertFeedItem, "title" | "link"> & { id?: string }> }
	| { kind: "error"; reason: string };

export type AlertRuleEvaluation = {
	/** null = sem veredito (fonte fora do ar, valor ilegível): cai na lógica de "não consegui verificar". */
	verdict: AlertVerdict | null;
	state: AlertRuleState;
	/** Motivo curto (pt-BR, visto pelo usuário) quando não há veredito. */
	reason?: string;
	/** Leitura formatada, para o card ("R$ 449,90"). */
	display?: string;
	/** Aviso sobre a leitura (pt-BR/idioma do bot), ex.: "cotação com atraso de ~30 min". */
	note?: string;
	suspect?: boolean;
};

type ValueCheck = Extract<AlertCheck, { kind: "value" }>;

function holds(check: ValueCheck, value: number, margin: number): boolean {
	const a = check.value as number;
	const m = Math.abs(a) * margin;
	switch (check.op) {
		case "lt":
			return value < a + m;
		case "lte":
			return value <= a + m;
		case "gt":
			return value > a - m;
		case "gte":
			return value >= a - m;
		case "between": {
			const b = check.value2 ?? a;
			return value >= a - m && value <= b + Math.abs(b) * margin;
		}
		case "eq":
			return value === a;
		case "neq":
			return value !== a;
		default:
			return false;
	}
}

function normalizeText(text: string): string {
	return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function textHolds(check: ValueCheck, text: string): boolean {
	const a = normalizeText(String(check.value));
	const t = normalizeText(text);
	if (check.op === "contains") return t.includes(a);
	return check.op === "eq" ? t === a : t !== a;
}

function pushSeen(seen: readonly string[], add: readonly string[]): string[] {
	const merged = [...seen.filter((id) => !add.includes(id)), ...add];
	return merged.slice(-ALERT_SEEN_IDS_MAX);
}

function inconclusive(state: AlertRuleState, reason: string): AlertRuleEvaluation {
	return { verdict: null, state, reason };
}

/** Item novo: primeira leitura só "semeia" o conjunto de vistos; depois avisa pelos ids que não estavam nele. */
function evaluateNewItems(rule: AlertRule, state: AlertRuleState, read: AlertRuleRead, now: Date, locale: BotLanguage): AlertRuleEvaluation {
	if (read.kind === "error") return inconclusive(state, read.reason);
	if (read.kind !== "items" || read.items.length === 0) return inconclusive(state, "a lista veio vazia");
	const items = read.items.map((item) => ({ ...item, key: alertItemKey(item) }));
	const ids = items.map((item) => item.key);
	const base = { ...state, lastReadAt: now.toISOString(), consecutive: 0 };
	const seen = state.seenIds ?? [];
	if (!state.seeded) {
		const display = `${ids.length}`;
		return { verdict: { triggered: false, summary: renderAlertMessage(rule, display, locale) }, state: { ...base, seeded: true, seenIds: pushSeen([], ids) }, display };
	}
	const fresh = items.filter((item) => !seen.includes(item.key));
	// Todos os ids mudaram de uma vez: a fonte trocou o esquema de ids; semeia de novo em vez de avisar tudo.
	if (fresh.length > 0 && fresh.length === items.length && seen.length >= 3) {
		return { verdict: { triggered: false, summary: renderAlertMessage(rule, `${items.length}`, locale) }, state: { ...base, seenIds: pushSeen([], ids) }, suspect: true };
	}
	const nextSeen = pushSeen(seen, ids);
	if (fresh.length === 0) {
		const latest = quoteAlertExternalText(items[0]!.title);
		return { verdict: { triggered: false, summary: renderAlertMessage(rule, latest, locale) }, state: { ...base, seenIds: nextSeen }, display: latest };
	}
	const first = quoteAlertExternalText(fresh[0]!.title);
	const display = fresh.length > 1 ? `${first} (+${fresh.length - 1})` : first;
	return { verdict: { triggered: true, summary: renderAlertMessage(rule, display, locale) }, state: { ...base, seenIds: nextSeen }, display };
}

export function evaluateAlertRule(input: {
	rule: AlertRule;
	state?: AlertRuleState;
	/** O alerta estava avisando (já notificou e a condição ainda não deixou de valer). */
	wasActive: boolean;
	read: AlertRuleRead;
	now: Date;
	locale?: BotLanguage;
}): AlertRuleEvaluation {
	const { rule, read, now, wasActive } = input;
	const locale = input.locale ?? "pt-BR";
	const state = input.state ?? {};
	if (rule.check.kind === "new_item") return evaluateNewItems(rule, state, read, now, locale);
	const check = rule.check;
	if (read.kind === "error") return inconclusive(state, read.reason);
	if (read.kind !== "text" && read.kind !== "number") return inconclusive(state, "a fonte devolveu outro tipo de dado");
	const text = read.kind === "text" ? (read.text?.replace(/\s+/g, " ").trim() ?? "") : "";
	if (read.kind === "text" && !text) return inconclusive(state, "não encontrei o valor na página");
	const stamp = now.toISOString();

	if (check.parse === "text") {
		if (read.kind !== "text") return inconclusive(state, "a fonte devolveu outro tipo de dado");
		const compared = text.slice(0, 200);
		const matches = textHolds(check, compared);
		// O texto lido é de terceiros: o que fica no estado e vai à mensagem é a citação saneada.
		const shown = sanitizeAlertExternalText(compared);
		return settle({ rule, check, state, wasActive, matches, stillHolds: matches, value: shown, display: quoteAlertExternalText(compared), stamp, locale });
	}

	const value = read.kind === "number" ? read.value : parseLocalizedNumber(text);
	if (value === null) return inconclusive(state, "o valor lido não é um número");
	if (!Number.isFinite(value) || Math.abs(value) > ABSURD_MAX || (check.parse === "money" && value <= 0)) return inconclusive(state, "o valor lido não faz sentido");
	const display = formatAlertNumber(value, check.parse, locale, check.currency) + alertSourceUnit(rule.source);
	const measured = read.kind === "number" && read.delayMinutes !== undefined && read.delayMinutes >= DELAY_MIN_MINUTES ? Math.round(read.delayMinutes) : undefined;
	// Até ~45 min é o atraso do plano do provedor ("atraso ~30 min"); acima disso o preço é de um ativo pouco negociado
	// e afirmar "atraso de 3 h" engana: o aviso diz a hora do último negócio.
	const delay = measured !== undefined && measured <= DELAY_MAX_MINUTES ? measured : undefined;
	const lastTradeAt = measured !== undefined && delay === undefined && read.kind === "number" && read.asOf ? read.asOf : undefined;
	const note = delay !== undefined ? delayNote(delay, locale) : lastTradeAt ? lastTradeNote(lastTradeAt, locale) : undefined;

	const previous = typeof state.lastValue === "number" ? state.lastValue : undefined;
	// Previsão do tempo muda de um dia para o outro por natureza (10% → 80% de chuva): o filtro de salto não vale.
	const volatile = rule.source.type === "weather";
	if (!volatile && previous !== undefined && previous !== 0 && Math.abs(value - previous) / Math.abs(previous) > ALERT_SUSPECT_JUMP) {
		const pending = state.suspect?.value;
		const confirmed = pending !== undefined && pending !== 0 && Math.abs(value - pending) / Math.abs(pending) <= ALERT_SUSPECT_CONFIRM;
		if (!confirmed) {
			// Não mexe no que já valia (nem rearma, nem avisa): só espera a próxima leitura confirmar.
			return {
				verdict: { triggered: wasActive, summary: renderAlertMessage(rule, display, locale) },
				state: { ...state, lastReadAt: stamp, suspect: { value } },
				display,
				...(note ? { note } : {}),
				suspect: true,
			};
		}
	}

	let baseline = state.baseline;
	let matches: boolean;
	let stillHolds: boolean;
	if (check.op === "changed_pct") {
		if (baseline === undefined) {
			return {
				verdict: { triggered: false, summary: renderAlertMessage(rule, display, locale) },
				state: { lastValue: value, lastReadAt: stamp, consecutive: 0, baseline: value, ...(delay ? { delayMinutes: delay } : {}), ...(lastTradeAt ? { lastTradeAt } : {}) },
				display,
				...(note ? { note } : {}),
			};
		}
		const pct = baseline === 0 ? (value === 0 ? 0 : 100) : (Math.abs(value - baseline) / Math.abs(baseline)) * 100;
		matches = pct >= (check.value as number);
		stillHolds = matches;
	} else {
		matches = holds(check, value, 0);
		stillHolds = holds(check, value, ALERT_HYSTERESIS);
	}
	const result = settle({ rule, check, state: { ...state, suspect: undefined }, wasActive, matches, stillHolds, value, display, stamp, locale });
	// Avisou agora: a base do "variou X%" passa a ser o valor que avisou.
	if (check.op === "changed_pct" && result.verdict?.triggered && !wasActive) baseline = value;
	// A cotação com atraso diz isso no próprio aviso: quem decide sabe que o preço não é o desta hora.
	const verdict = result.verdict && note && result.verdict.triggered ? { ...result.verdict, summary: `${result.verdict.summary} (${note})`.slice(0, 340) } : result.verdict;
	const { delayMinutes: _previousDelay, lastTradeAt: _previousTrade, ...cleanState } = result.state;
	return { ...result, verdict, ...(note ? { note } : {}), state: { ...cleanState, ...(delay ? { delayMinutes: delay } : {}), ...(lastTradeAt ? { lastTradeAt } : {}), ...(baseline !== undefined ? { baseline } : {}) } };
}

const DELAY_NOTE: Record<string, string> = {
	"pt-BR": "cotação com atraso de ~{n} min",
	"en-US": "quote delayed by ~{n} min",
	"es-ES": "cotización con retraso de ~{n} min",
};

/** Atraso só vale a menção a partir de 10 min (abaixo disso é ruído de relógio). */
const DELAY_MIN_MINUTES = 10;
/** Acima disso não se fala em "atraso": fala-se do horário do último negócio. */
export const ALERT_DELAY_MAX_MINUTES = 45;
const DELAY_MAX_MINUTES = ALERT_DELAY_MAX_MINUTES;

const TRADE_NOTE: Record<string, string> = {
	"pt-BR": "último negócio às {time}",
	"en-US": "last trade at {time}",
	"es-ES": "último negocio a las {time}",
};

/** HH:MM de Brasília (a B3 opera em UTC-3 fixo) do último negócio. */
export function brasiliaClock(iso: string): string {
	const shifted = new Date(Date.parse(iso) - 3 * 3_600_000);
	return `${String(shifted.getUTCHours()).padStart(2, "0")}:${String(shifted.getUTCMinutes()).padStart(2, "0")}`;
}

function lastTradeNote(iso: string, locale: BotLanguage): string | undefined {
	if (!Number.isFinite(Date.parse(iso))) return undefined;
	return (TRADE_NOTE[locale] ?? TRADE_NOTE["pt-BR"]!).replace("{time}", brasiliaClock(iso));
}
function delayNote(minutes: number | undefined, locale: BotLanguage): string | undefined {
	if (minutes === undefined || !Number.isFinite(minutes) || minutes < DELAY_MIN_MINUTES) return undefined;
	return (DELAY_NOTE[locale] ?? DELAY_NOTE["pt-BR"]!).replace("{n}", String(Math.round(minutes)));
}

function settle(input: {
	rule: AlertRule;
	check: ValueCheck;
	state: AlertRuleState;
	wasActive: boolean;
	matches: boolean;
	stillHolds: boolean;
	value: number | string;
	display: string;
	stamp: string;
	locale: BotLanguage;
}): AlertRuleEvaluation {
	const { state, wasActive, matches, stillHolds } = input;
	let triggered: boolean;
	let consecutive: number;
	if (wasActive) {
		// Já avisou: continua em alerta enquanto a condição vale (com folga); só rearma quando sai dela de verdade.
		triggered = stillHolds;
		consecutive = triggered ? Math.max(state.consecutive ?? 0, ALERT_DEBOUNCE_READS) : 0;
	} else {
		consecutive = matches ? (state.consecutive ?? 0) + 1 : 0;
		triggered = consecutive >= ALERT_DEBOUNCE_READS;
	}
	const { suspect: _drop, ...rest } = state;
	return {
		verdict: { triggered, summary: renderAlertMessage(input.rule, input.display, input.locale) },
		state: { ...rest, lastValue: input.value, lastReadAt: input.stamp, consecutive },
		display: input.display,
	};
}

/** Novo item não usa "já avisou" para calar o próximo aviso: cada item novo avisa. */
export function alertWasActiveForRule(rule: AlertRule, active: boolean): boolean {
	return rule.check.kind === "new_item" ? false : active;
}
