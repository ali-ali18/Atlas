import type { UsagePeriod, UsageTotals } from "@workspace/shared";

import { formatCompactNumber } from "@/lib/format";
import { DEFAULT_UI_LOCALE, type UiLocale } from "@/lib/i18n/locales";
import { defaultTranslator, type Translator } from "@/lib/i18n/translator";

/** Textos e contas puras da seção Uso (sem React). */

export function usagePeriodOptions({ t }: Translator = defaultTranslator): readonly { value: UsagePeriod; label: string }[] {
	return [
		{ value: "today", label: t("settings.usage.period.today") },
		{ value: "7d", label: t("settings.usage.period.7d") },
		{ value: "30d", label: t("settings.usage.period.30d") },
	];
}

/**
 * Custo em US$ no idioma da tela; parcial quando há chamadas sem custo informado.
 * Espelha `formatCostLabel` de shared, que só fala pt-BR.
 */
export function totalCostLabel(
	totals: { costUsd?: number | null; costUnknownCalls?: number },
	translator: Translator = defaultTranslator,
): string {
	const { t, tn } = translator;
	const unknown = totals.costUnknownCalls && totals.costUnknownCalls > 0 ? totals.costUnknownCalls : 0;
	const known =
		typeof totals.costUsd === "number"
			? `US$ ${totals.costUsd.toFixed(4)}`
			: null;
	if (unknown === 0) return known ?? t("settings.usage.costUnknown");
	const calls = tn("settings.usage.callsNoCost", unknown);
	return known ? t("settings.usage.costPartial", { known, calls }) : t("settings.usage.costOnlyUnknown", { calls });
}

/** Custo de uma linha: igual ao total, com "+ plano" quando houve chamadas no plano ChatGPT. */
export function rowCostLabel(
	totals: { costUsd?: number | null; costUnknownCalls?: number; planCalls?: number },
	translator: Translator = defaultTranslator,
): string {
	if ((totals.planCalls ?? 0) <= 0) return totalCostLabel(totals, translator);
	const priced =
		typeof totals.costUsd === "number" || (totals.costUnknownCalls ?? 0) > 0 ? totalCostLabel(totals, translator) : null;
	return priced ? translator.t("settings.usage.pricedPlusPlan", { priced }) : translator.t("settings.usage.plan");
}

export function runsLabel(runs: number, { tn }: Translator = defaultTranslator): string {
	return tn("settings.usage.runs", runs);
}

export function tokensLabel(tokens: number, locale: UiLocale = DEFAULT_UI_LOCALE): string {
	return formatCompactNumber(tokens, locale);
}

/**
 * Largura da barra (0 a 100) da linha em relação à maior da lista: por custo
 * quando alguma linha tem custo, senão por número de execuções (só plano).
 */
export function barPercent(
	row: Pick<UsageTotals, "costUsd" | "runs">,
	rows: readonly Pick<UsageTotals, "costUsd" | "runs">[],
): number {
	const maxCost = Math.max(0, ...rows.map((item) => item.costUsd ?? 0));
	if (maxCost > 0) return Math.round(((row.costUsd ?? 0) / maxCost) * 100);
	const maxRuns = Math.max(0, ...rows.map((item) => item.runs));
	return maxRuns > 0 ? Math.round((row.runs / maxRuns) * 100) : 0;
}
