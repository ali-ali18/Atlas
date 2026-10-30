import {
	alertSourceFloorMinutes,
	alertWasActiveForRule,
	evaluateAlertRule,
	type AlertRule,
	type AlertRuleRead,
	type BotLanguage,
	type RoutineAlert,
	type RoutineTriggerType,
} from "@workspace/shared";
import { planAlertRun, settleAlertRun, type AlertRunPlan, type AlertSettleDeps } from "./routine-alert.js";

/**
 * Alerta com regra: o servidor lê a fonte e avalia a condição sozinho, sem AgentRun nem modelo. O veredito
 * entra no mesmo caminho do alerta de sempre (`planAlertRun` + `settleAlertRun`): debounce de aviso, estado,
 * backoff do intervalo, "não consegui verificar" uma vez só, push.
 */

/** Resultado da leitura (formato estrutural de `readAlertRule` em `@workspace/search`). */
export type RuleSourceResult =
	| { ok: true; read: AlertRuleRead; host: string; ms: number }
	| { ok: false; code: string; reason: string; host: string; ms: number };

export type RuleAlertDeps = AlertSettleDeps & {
	read: (rule: AlertRule) => Promise<RuleSourceResult>;
	/** Fecha a execução da rotina sem modelo (escopado pelo dono). */
	settleRun: (userId: string, routineRunId: string, input: { status: "succeeded"; summary: string }) => Promise<boolean>;
};

export type RuleAlertOutcome = { status: "succeeded"; summary: string; plan: AlertRunPlan };

/** Folga de relógio: o disparo do agendador pode chegar um pouco antes do piso. */
const SPACING_TOLERANCE = 0.9;

/**
 * Espaçamento mínimo entre leituras da mesma fonte. O piso técnico vale sempre (protege o site de terceiros,
 * mesmo com cron ou intervalo editado à mão); em alerta por horário (cron) o espaçamento automático "quando nada
 * muda" mora em `alert.backoff.to`, porque o cron em si não pode ser alargado.
 */
export function ruleAlertSpacingMinutes(rule: AlertRule, alert: Pick<RoutineAlert, "backoff">, triggerType: RoutineTriggerType): number {
	const floor = alertSourceFloorMinutes(rule.source);
	return triggerType === "cron" ? Math.max(floor, alert.backoff?.to ?? 0) : floor;
}

/** Pular este disparo? (leitura recente demais para a fonte). null = pode conferir. */
export function ruleAlertSkipReason(input: { rule: AlertRule; alert: Pick<RoutineAlert, "backoff" | "checkedAt">; triggerType: RoutineTriggerType; now: Date }): string | null {
	const last = input.alert.checkedAt ? Date.parse(input.alert.checkedAt) : Number.NaN;
	if (!Number.isFinite(last)) return null;
	const minutes = ruleAlertSpacingMinutes(input.rule, input.alert, input.triggerType);
	if (input.now.getTime() - last >= minutes * 60_000 * SPACING_TOLERANCE) return null;
	return `Espaçado: esta fonte só é conferida a cada ${minutes} min`;
}

export type RuleAlertRunInput = {
	userId: string;
	routineId: string;
	routineRunId: string;
	routineName: string;
	conversationId: string | null;
	alert: RoutineAlert & { rule: AlertRule };
	triggerType: RoutineTriggerType;
	/** Intervalo atual (só rotina por intervalo). */
	interval: { everyMinutes: number } | null;
	locale: BotLanguage;
	now: Date;
};

export async function runRuleAlert(input: RuleAlertRunInput, deps: RuleAlertDeps): Promise<RuleAlertOutcome> {
	const log = deps.log ?? ((line: string) => console.log(line));
	const { alert, now } = input;
	const rule = alert.rule;
	const result = await deps.read(rule).catch((): RuleSourceResult => ({ ok: false, code: "network", reason: "não consegui ler a fonte", host: "?", ms: 0 }));
	const read: AlertRuleRead = result.ok ? result.read : { kind: "error", reason: result.reason };
	const wasActive = alertWasActiveForRule(rule, alert.active);
	const evaluation = evaluateAlertRule({ rule, ...(alert.ruleState ? { state: alert.ruleState } : {}), wasActive, read, now, locale: input.locale });

	// Alerta por horário (cron) não tem intervalo para alargar: o espaçamento fica só no estado (`backoff`).
	const floor = alertSourceFloorMinutes(rule.source);
	const interval = input.triggerType === "interval" ? input.interval : { everyMinutes: alert.backoff?.to ?? floor };
	const plan = planAlertRun({
		alert: { ...alert, active: wasActive },
		routineName: input.routineName,
		verdict: evaluation.verdict,
		modelText: evaluation.reason ?? null,
		interval,
		now,
	});
	const { everyMinutes: _widened, ...planWithoutInterval } = plan;
	const finalPlan: AlertRunPlan = {
		...(input.triggerType === "interval" ? plan : planWithoutInterval),
		next: { ...plan.next, rule, ruleState: evaluation.state },
	};
	const inconclusive = evaluation.verdict === null;
	const outcome = inconclusive ? `inconclusive:${result.ok ? "valor" : result.code}` : finalPlan.decision.transition;
	log(`[alert-rule] routine=${input.routineId} host=${result.host} outcome=${outcome} notify=${finalPlan.notify} ms=${result.ms}`);

	await settleAlertRun(finalPlan, { userId: input.userId, routineId: input.routineId, conversationId: input.conversationId, expectCheckedAt: alert.checkedAt ?? null }, deps);
	// Sem leitura (site fora do ar, valor ilegível) também fecha como concluída, com o "não consegui verificar" no
	// resumo, igual ao caminho do modelo: "failed" alimenta a lista de falhas do diagnóstico a cada ciclo e não é
	// falha do sistema (o aviso ao usuário já sai uma vez só).
	const status = "succeeded" as const;
	await deps
		.settleRun(input.userId, input.routineRunId, { status, summary: finalPlan.text })
		.catch((error) => console.error(`[alert-rule] execução não fechada run=${input.routineRunId}`, error instanceof Error ? error.message : "erro"));
	return { status, summary: finalPlan.text, plan: finalPlan };
}

