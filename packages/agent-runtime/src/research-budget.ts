/**
 * Parte B — orçamento padrão das tools de pesquisa (`web_search`/`web_extract`).
 *
 * Como aplicar (INTEGRADOR — não aplicar aqui):
 * - fundir com a política do bot: `mergeResearchBudget(policy?.maxCallsPerTool)`;
 * - passar o resultado como `maxCallsPerTool` da política entregue a
 *   `resolveBudget()` (ver `budget.ts`) / `buildStoredBudget`.
 * Só tools de pesquisa: tetos de `click`/`screenshot` valeriam para qualquer
 * run (desktop, rotinas) e ficam a cargo da política do bot.
 *
 * Estado: idempotência/contagem usam o checkpoint existente (`toolCallCounts`
 * + step records via `onStep` em `computer-use.ts`) — nada em memória fora do
 * run. Não criar store novo.
 */

export const RESEARCH_BUDGET_DEFAULTS = {
	web_search: 10,
	web_extract: 12,
} as const;

export type ResearchBudgetDefaults = typeof RESEARCH_BUDGET_DEFAULTS;

/**
 * Preenche os tetos faltantes com `RESEARCH_BUDGET_DEFAULTS` sem sobrescrever
 * valores explícitos. Valores inválidos (<= 0, não finitos) são ignorados.
 * Chaves extras da política (ex.: `navigate`) são preservadas.
 */
export function mergeResearchBudget(
	explicit?: Record<string, number> | null | undefined,
): Record<string, number> {
	const merged: Record<string, number> = { ...RESEARCH_BUDGET_DEFAULTS };
	if (!explicit || typeof explicit !== "object") return merged;
	for (const [name, cap] of Object.entries(explicit)) {
		if (typeof cap !== "number" || !Number.isFinite(cap) || cap <= 0) continue;
		merged[name] = Math.floor(cap);
	}
	return merged;
}
