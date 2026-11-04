import { ROUTINE_MAX_COST_MAX_USD, ROUTINE_MAX_COST_MIN_USD, ROUTINE_MAX_STEPS_MAX, ROUTINE_MAX_STEPS_MIN, type RoutineLimits, type RoutineLimitsPatch } from "@workspace/shared";
import { formatCurrency } from "@/lib/format";
import { getActiveTranslator } from "@/lib/i18n/active";
import type { Translator } from "@/lib/i18n/translator";

/** Passos por execução da rotina sem pessoa quando o dono não configurou (decisão D4). */
export const DEFAULT_ROUTINE_STEPS = 40;

/** "Até 40 passos por execução · Sem teto de gasto" (no idioma da tela). */
export function routineLimitsSummary(limits: RoutineLimits | undefined, translator: Translator = getActiveTranslator()): string {
	const steps = translator.tn("routines.limits.steps", limits?.maxSteps ?? DEFAULT_ROUTINE_STEPS);
	const cost = limits?.maxCostUsd !== undefined ? translator.t("routines.limits.cap", { amount: formatCurrency(limits.maxCostUsd, "USD", translator.locale) }) : translator.t("routines.limits.noCap");
	return `${steps} · ${cost}`;
}

export type RoutineLimitsDraft = { steps: string; cost: string };

export function limitsToDraft(limits: RoutineLimits | undefined): RoutineLimitsDraft {
	return { steps: limits?.maxSteps !== undefined ? String(limits.maxSteps) : "", cost: limits?.maxCostUsd !== undefined ? String(limits.maxCostUsd) : "" };
}

/**
 * Campos do formulário → patch da API (`null` = volta ao padrão). Vazio = padrão; fora da faixa = erro por campo, com
 * texto para o dono (a validação final continua sendo a da API, em shared).
 */
export function draftToLimitsPatch(draft: RoutineLimitsDraft): { ok: true; patch: RoutineLimitsPatch } | { ok: false; field: "steps" | "cost" } {
	const stepsText = draft.steps.trim();
	const costText = draft.cost.trim().replace(",", ".");
	let maxSteps: number | null = null;
	if (stepsText) {
		const value = Number(stepsText);
		if (!/^\d+$/.test(stepsText) || value < ROUTINE_MAX_STEPS_MIN || value > ROUTINE_MAX_STEPS_MAX) return { ok: false, field: "steps" };
		maxSteps = value;
	}
	let maxCostUsd: number | null = null;
	if (costText) {
		const value = Number(costText);
		if (!/^\d+(\.\d{1,2})?$/.test(costText) || value < ROUTINE_MAX_COST_MIN_USD || value > ROUTINE_MAX_COST_MAX_USD) return { ok: false, field: "cost" };
		maxCostUsd = value;
	}
	return { ok: true, patch: { maxSteps, maxCostUsd } };
}
