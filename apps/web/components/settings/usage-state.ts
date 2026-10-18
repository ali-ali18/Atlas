import { formatCostLabel, type UsagePeriod, type UsageTotals } from "@workspace/shared";

/** Textos e contas puras da seção Uso (sem React). */

export const USAGE_PERIOD_OPTIONS: readonly { value: UsagePeriod; label: string }[] = [
	{ value: "today", label: "Hoje" },
	{ value: "7d", label: "Últimos 7 dias" },
	{ value: "30d", label: "Últimos 30 dias" },
];

/** Custo do período em US$; parcial quando há chamadas sem custo informado. */
export function totalCostLabel(totals: Pick<UsageTotals, "costUsd" | "costUnknownCalls">): string {
	return formatCostLabel(totals.costUsd, totals.costUnknownCalls);
}

export function runsLabel(runs: number): string {
	return `${runs} ${runs === 1 ? "execução" : "execuções"}`;
}

const compact = new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 });

export function tokensLabel(tokens: number): string {
	return compact.format(tokens);
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
