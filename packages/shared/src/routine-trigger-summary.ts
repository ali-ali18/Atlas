import { describeEmailTrigger } from "./routine-email.js";
import { describeGithubTrigger } from "./routine-github.js";
import { formatIntervalSummary } from "./routine-interval.js";
import { formatOnceSummary } from "./routine-once.js";
import { describeRoutineProposalSchedule } from "./routine-proposal.js";
import type { RoutineRecord } from "./routines.js";

/** O pedaço da rotina que diz QUANDO ela roda. As funções abaixo só leem isso. */
export type RoutineTriggerView = Pick<RoutineRecord, "triggerType" | "schedule" | "timezone" | "once" | "interval" | "email" | "github" | "hook">;

/**
 * O gatilho da rotina em frase ("Uma vez · 03/10 às 10:00", "A cada 50 min", "todo dia às 8h", "e-mail (…)", "GitHub (…)", "webhook").
 * Fonte única da lista de rotinas (legado e v4). `hookKey` acrescenta o identificador do webhook (o legado mostra; o v4 não: é interno).
 */
export function describeRoutineTrigger(routine: RoutineTriggerView, opts: { hookKey?: boolean } = {}): string {
	if (routine.triggerType === "event") {
		if (routine.email) return `e-mail (${describeEmailTrigger(routine.email)})`;
		if (routine.github) return `GitHub (${describeGithubTrigger(routine.github)})`;
		return `webhook${opts.hookKey && routine.hook?.hookKey ? ` · ${routine.hook.hookKey}` : ""}`;
	}
	if (routine.triggerType === "once") return formatOnceSummary(routine.once?.runAt ?? "", routine.timezone);
	if (routine.triggerType === "interval") return formatIntervalSummary(routine.interval?.everyMinutes ?? 0);
	return describeRoutineProposalSchedule({ schedule: routine.schedule ?? undefined });
}

/**
 * Quando a rotina roda de novo, só quando dá para dizer com certeza (ISO). `once`: o horário marcado, se ainda não passou.
 * `interval`: última execução (ou criação) mais o intervalo, se ainda não passou. Cron e evento: `null` (o gatilho em frase já
 * diz a cadência; aqui não há cálculo de cron e evento só roda quando acontece). Pausada: `null`.
 */
export function routineNextRunAt(
	routine: Pick<RoutineRecord, "enabled" | "triggerType" | "once" | "interval" | "lastRunAt" | "createdAt">,
	now: Date,
): string | null {
	if (!routine.enabled) return null;
	if (routine.triggerType === "once") {
		const at = Date.parse(routine.once?.runAt ?? "");
		return Number.isNaN(at) || at <= now.getTime() ? null : new Date(at).toISOString();
	}
	if (routine.triggerType === "interval") {
		const every = routine.interval?.everyMinutes ?? 0;
		const base = Date.parse(routine.lastRunAt ?? routine.createdAt);
		if (!(every > 0) || Number.isNaN(base)) return null;
		const next = base + every * 60_000;
		return next <= now.getTime() ? null : new Date(next).toISOString();
	}
	return null;
}
