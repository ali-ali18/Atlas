/**
 * Alerta por condição: uma rotina de verificação (cron ou intervalo) que só avisa quando a condição
 * passa a valer ("me avisa se o estoque da canela cair abaixo de 10"). Funções puras: validação do que
 * o agente propõe, decisão de aviso com debounce, frase do card e texto do resultado de cada execução.
 *
 * O estado (`active`) mora na própria rotina: enquanto a condição continua verdadeira não avisa de
 * novo; só volta a avisar depois que ela deixou de valer pelo menos uma vez.
 */
import type { AlertRuleState } from "./alert-rule-eval.js";
import { describeAlertRuleCompact, describeAlertRuleCondition, parseAlertRule, sameAlertRule, type AlertRule } from "./alert-rule.js";
import { DEFAULT_BOT_LANGUAGE, type BotLanguage } from "./bot-language.js";
import { describeRoutineProposalSchedule } from "./routine-proposal.js";
import { describeAlertCron } from "./routine-alert-schedule.js";
import type { RoutineTriggerType } from "./routines.js";

export const ALERT_CONDITION_MIN = 3;
export const ALERT_CONDITION_MAX = 300;
export const ALERT_HINT_MAX = 300;
export const ALERT_SUMMARY_MAX = 300;
/** Alertas ativos (rotina ligada com alerta) por pessoa: protege fontes de terceiros e a fila do worker. */
export const ALERT_ACTIVE_LIMIT = 30;

/** Texto (pt-BR, visto pelo usuário) quando a pessoa já tem o máximo de alertas ativos. */
export function alertLimitMessage(limit: number = ALERT_ACTIVE_LIMIT): string {
	return `Você já tem ${limit} alertas ativos, que é o máximo. Pause ou apague um alerta para criar outro.`;
}

/** Só rotinas que rodam por tempo conseguem "verificar de tempos em tempos". */
export function alertSupportsTrigger(triggerType: RoutineTriggerType): boolean {
	return triggerType === "cron" || triggerType === "interval";
}

/** O que o usuário/agente define: a condição em linguagem natural e uma dica opcional de onde olhar. */
export type RoutineAlertConfig = {
	/** Frase que completa "avisa se …", no idioma do usuário (ex.: "o estoque da canela cair abaixo de 10"). */
	condition: string;
	/** Dica para quem verifica (qual ferramenta, produto, campo, limite). Não aparece no card. */
	hint?: string;
	/**
	 * Regra determinística (fonte + condição): o servidor confere sozinho, sem modelo. Ausente = o jeito de
	 * sempre (o modelo verifica a `condition`); linha antiga e versão antiga seguem funcionando assim.
	 */
	rule?: AlertRule;
};

/** Config + estado do último ciclo (guardado em `Routine.alertJson`). */
export type RoutineAlert = RoutineAlertConfig & {
	/** A condição valia na última verificação conclusiva (base do debounce). */
	active: boolean;
	checkedAt?: string;
	triggeredAt?: string;
	lastSummary?: string;
	/** A última verificação não chegou a um veredito (dados ilegíveis): o aviso de "não consegui verificar" sai uma vez só. */
	unverified?: boolean;
	/** Conferências tranquilas e iguais, seguidas (base do backoff do intervalo). */
	quietStreak?: number;
	/** Intervalo original e o atual depois de espaçar as conferências (ver `planAlertBackoff`). */
	backoff?: { base: number; to: number };
	/** Estado da leitura quando há `rule` (último valor, debounce, itens vistos). */
	ruleState?: AlertRuleState;
};

export type ParseRoutineAlertResult = { ok: true; alert: RoutineAlertConfig } | { ok: false; error: string };

function cleanLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

/**
 * Valida o objeto `alert` vindo da tool do agente ou da API. Mensagens em pt-BR (viram erro acionável).
 * Com `rule`, a `condition` é gerada da regra (no idioma pedido) quando não vem.
 */
export function parseRoutineAlertInput(raw: unknown, options: { locale?: BotLanguage } = {}): ParseRoutineAlertResult {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { ok: false, error: "alert deve ser um objeto com a condição (ex.: { condition: \"o estoque da canela cair abaixo de 10\" })" };
	}
	const row = raw as Record<string, unknown>;
	let rule: AlertRule | undefined;
	if (row.rule !== undefined && row.rule !== null) {
		const parsedRule = parseAlertRule(row.rule);
		if (!parsedRule.ok) return { ok: false, error: `alert.rule inválida: ${parsedRule.error}` };
		rule = parsedRule.rule;
	}
	let condition = typeof row.condition === "string" ? cleanLine(row.condition) : "";
	if (!condition && rule) condition = describeAlertRuleCondition(rule, options.locale ?? DEFAULT_BOT_LANGUAGE);
	if (condition.length < ALERT_CONDITION_MIN) return { ok: false, error: "alert.condition vazia: descreva quando avisar" };
	if (condition.length > ALERT_CONDITION_MAX) return { ok: false, error: `alert.condition longa demais (máximo ${ALERT_CONDITION_MAX} caracteres)` };
	if (row.hint !== undefined && row.hint !== null && typeof row.hint !== "string") return { ok: false, error: "alert.hint deve ser texto" };
	const hint = typeof row.hint === "string" ? cleanLine(row.hint) : "";
	if (hint.length > ALERT_HINT_MAX) return { ok: false, error: `alert.hint longa demais (máximo ${ALERT_HINT_MAX} caracteres)` };
	return { ok: true, alert: { condition, ...(hint ? { hint } : {}), ...(rule ? { rule } : {}) } };
}

/** Lê `alertJson` do banco com tolerância (linha antiga, lixo → null). */
export function parseRoutineAlert(value: unknown): RoutineAlert | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const row = value as Record<string, unknown>;
	// Regra ilegível (versão futura, lixo): vale como alerta comum, conferido pelo modelo.
	const parsed = parseRoutineAlertInput(row);
	const tolerant = parsed.ok ? parsed : parseRoutineAlertInput({ ...row, rule: undefined });
	if (!tolerant.ok) return null;
	return {
		...tolerant.alert,
		active: row.active === true,
		...(typeof row.checkedAt === "string" ? { checkedAt: row.checkedAt } : {}),
		...(typeof row.triggeredAt === "string" ? { triggeredAt: row.triggeredAt } : {}),
		...(typeof row.lastSummary === "string" ? { lastSummary: row.lastSummary.slice(0, ALERT_SUMMARY_MAX) } : {}),
		...(row.unverified === true ? { unverified: true } : {}),
		...(typeof row.quietStreak === "number" && row.quietStreak > 0 ? { quietStreak: Math.trunc(row.quietStreak) } : {}),
		...parseBackoff(row.backoff),
		...(tolerant.alert.rule ? parseRuleState(row.ruleState) : {}),
	};
}

function parseRuleState(value: unknown): { ruleState?: AlertRuleState } {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const row = value as Record<string, unknown>;
	const state: AlertRuleState = {};
	if (typeof row.lastValue === "number" || typeof row.lastValue === "string") state.lastValue = typeof row.lastValue === "string" ? row.lastValue.slice(0, 200) : row.lastValue;
	if (typeof row.lastReadAt === "string") state.lastReadAt = row.lastReadAt;
	if (typeof row.consecutive === "number" && row.consecutive > 0) state.consecutive = Math.min(1000, Math.trunc(row.consecutive));
	const suspect = row.suspect as { value?: unknown } | null | undefined;
	if (suspect && typeof suspect.value === "number") state.suspect = { value: suspect.value };
	if (typeof row.baseline === "number") state.baseline = row.baseline;
	if (Array.isArray(row.seenIds)) state.seenIds = row.seenIds.filter((id): id is string => typeof id === "string").slice(-200);
	if (row.seeded === true) state.seeded = true;
	if (typeof row.delayMinutes === "number" && row.delayMinutes > 0) state.delayMinutes = Math.min(45, Math.round(row.delayMinutes));
	if (typeof row.lastTradeAt === "string" && Number.isFinite(Date.parse(row.lastTradeAt))) state.lastTradeAt = row.lastTradeAt.slice(0, 40);
	return Object.keys(state).length > 0 ? { ruleState: state } : {};
}

function parseBackoff(value: unknown): { backoff?: { base: number; to: number } } {
	if (!value || typeof value !== "object") return {};
	const { base, to } = value as Record<string, unknown>;
	return typeof base === "number" && typeof to === "number" && base > 0 && to > base ? { backoff: { base, to } } : {};
}

/** Config nova mantendo o estado quando a condição e a regra não mudaram; senão começa "de fora" (pode avisar na hora). */
export function applyAlertConfig(previous: RoutineAlert | null, next: RoutineAlertConfig): RoutineAlert {
	const hint = next.hint ? { hint: next.hint } : {};
	const rule = next.rule ? { rule: next.rule } : {};
	if (previous && previous.condition === next.condition && sameAlertRule(previous.rule, next.rule)) {
		const { hint: _old, rule: _rule, ...kept } = previous;
		return { ...kept, ...hint, ...rule };
	}
	return { condition: next.condition, ...hint, ...rule, active: false };
}

export type AlertVerdict = { triggered: boolean; summary: string };
export type ParseAlertVerdictResult = { ok: true; verdict: AlertVerdict } | { ok: false; error: string };

/** Valida os argumentos de `report_alert` (texto do erro em inglês: volta ao modelo). */
export function parseAlertVerdict(args: unknown): ParseAlertVerdictResult {
	const row = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
	if (typeof row.triggered !== "boolean") return { ok: false, error: "triggered must be a boolean (true when the alert condition holds right now, false otherwise)" };
	const summary = typeof row.summary === "string" ? cleanLine(row.summary) : "";
	if (!summary) return { ok: false, error: "summary is required: one short sentence with the concrete value you found" };
	return { ok: true, verdict: { triggered: row.triggered, summary: summary.length > ALERT_SUMMARY_MAX ? `${summary.slice(0, ALERT_SUMMARY_MAX - 1).trimEnd()}…` : summary } };
}

export type AlertTransition = "triggered" | "still" | "reset" | "quiet" | "inconclusive";
export type AlertDecision = { transition: AlertTransition; notify: boolean; active: boolean; unverified: boolean };

/**
 * Debounce: avisa só na virada (falso → verdadeiro). Verdadeiro de novo = ainda em alerta, sem aviso;
 * verdadeiro → falso rearma. Sem veredito (dados ilegíveis, conector fora) não muda `active`, e o aviso
 * "não consegui verificar" sai só na primeira vez seguida, para não repetir a cada ciclo.
 */
export function decideAlertNotification(input: { wasActive: boolean; wasUnverified?: boolean; verdict: AlertVerdict | null }): AlertDecision {
	if (!input.verdict) return { transition: "inconclusive", notify: input.wasUnverified !== true, active: input.wasActive, unverified: true };
	if (input.verdict.triggered) {
		return input.wasActive
			? { transition: "still", notify: false, active: true, unverified: false }
			: { transition: "triggered", notify: true, active: true, unverified: false };
	}
	return { transition: input.wasActive ? "reset" : "quiet", notify: false, active: false, unverified: false };
}

/** Estado novo da rotina depois de uma verificação. */
export function nextAlertState(previous: RoutineAlert, decision: AlertDecision, verdict: AlertVerdict | null, now: Date): RoutineAlert {
	const { unverified: _was, ...rest } = previous;
	if (!verdict) return { ...rest, checkedAt: now.toISOString(), unverified: true };
	return {
		...rest,
		active: decision.active,
		checkedAt: now.toISOString(),
		lastSummary: verdict.summary,
		...(decision.transition === "triggered" ? { triggeredAt: now.toISOString() } : {}),
	};
}

/** Texto do resultado da execução: o que entra na conversa (só quando avisa) e no histórico da rotina. */
export function buildAlertRunText(decision: AlertDecision, verdict: AlertVerdict | null, context: { name?: string; reason?: string } = {}): string {
	if (!verdict) {
		const who = context.name ? ` “${context.name}”` : "";
		const reason = context.reason?.trim();
		return `⚠️ Não consegui verificar o alerta${who}${reason ? `: ${reason}` : " desta vez"}.`;
	}
	switch (decision.transition) {
		case "triggered":
			return `⚠️ ${verdict.summary}`;
		case "still":
			return `Continua em alerta: ${verdict.summary}`;
		case "reset":
			return `Voltou ao normal: ${verdict.summary}`;
		default:
			return `Tudo certo: ${verdict.summary}`;
	}
}

function lowerFirst(text: string): string {
	return text.length > 0 ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

/** "o estoque cair abaixo de 10" também aceita "se o estoque…" ou "Avisar se …": sempre completa "avisa se …". */
export function alertConditionPhrase(condition: string): string {
	return cleanLine(condition).replace(/^(?:avis(?:a|ar|e)\s+)?se\s+/i, "");
}

/** "Alerta · confere a cada 30 min · avisa se o estoque da canela cair abaixo de 10" (sem cron nem modo interno). */
export function formatRoutineAlertSentence(alert: Pick<RoutineAlertConfig, "condition">, cadence: string): string {
	const when = lowerFirst(cleanLine(cadence));
	return `Alerta · confere ${when || "de tempos em tempos"} · avisa se ${alertConditionPhrase(alert.condition)}`;
}

/** Frase do alerta de uma rotina (card, lista e detalhe), com a cadência lida do gatilho. null = não é rotina de alerta. */
export function describeRoutineAlertSentence(routine: {
	alert?: Pick<RoutineAlertConfig, "condition" | "rule"> | null;
	triggerType: RoutineTriggerType;
	schedule?: string | null;
	interval?: { everyMinutes: number } | null;
}): string | null {
	if (!routine.alert?.condition) return null;
	const cadence =
		(routine.triggerType === "cron" ? describeAlertCron(routine.schedule) : null) ??
		describeRoutineProposalSchedule(
			routine.triggerType === "interval" && routine.interval ? { everyMinutes: routine.interval.everyMinutes } : { schedule: routine.schedule ?? undefined },
		);
	// Alerta com regra: a frase mostra a regra ("tênis < R$ 400,00"), não o "avisa se …" em texto livre.
	if (routine.alert.rule) return `Alerta · ${describeAlertRuleCompact(routine.alert.rule, DEFAULT_BOT_LANGUAGE)} · ${lowerFirst(cleanLine(cadence))}${routine.alert.rule.source.type === "quote" ? " no pregão" : ""}`;
	return formatRoutineAlertSentence(routine.alert, cadence);
}
