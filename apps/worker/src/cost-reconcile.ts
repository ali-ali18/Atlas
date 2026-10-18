import { fetchGenerationCost, type GenerationCostResult } from "@workspace/llm";

/** Máximo de gerações consultadas por run (reconciliação limitada). */
export const COST_RECONCILE_MAX_PER_RUN = 20;
export const COST_RECONCILE_TIMEOUT_MS = 8_000;
export const COST_RECONCILE_INITIAL_DELAY_MS = 8_000;
export const COST_RECONCILE_RETRY_DELAY_MS = 15_000;
export const COST_RECONCILE_MAX_RETRIES = 2;

export type CostReconcileDeps = {
	listMissing: (input: { runId: string; userId: string; limit: number }) => Promise<Array<{ stepId: string; generationId: string }>>;
	apply: (input: { runId: string; userId: string; stepId: string; costUsd: number }) => Promise<boolean>;
	fetchCost?: (input: { apiKey: string; generationId: string; timeoutMs: number }) => Promise<GenerationCostResult>;
	/** O OpenRouter leva alguns segundos para indexar a geração (404 até lá). */
	delayMs?: number;
	/** Espera entre as novas tentativas dos passos que ainda deram 404. */
	retryDelayMs?: number;
	maxRetries?: number;
	sleep?: (ms: number) => Promise<void>;
};

/**
 * Melhor esforço, depois que o run concluiu: preenche o custo dos passos que o
 * OpenRouter não informou, pelo id da geração. Espera as estatísticas ficarem
 * prontas (atraso inicial + poucas novas tentativas só para 404). Idempotente (o
 * db só aplica a passos ainda sem custo), limitada e que NUNCA lança nem
 * registra a chave.
 */
export async function reconcileRunCosts(
	input: { runId: string; userId: string; apiKey: string },
	deps: CostReconcileDeps,
): Promise<{ checked: number; reconciled: number }> {
	const result = { checked: 0, reconciled: 0 };
	try {
		const missing = await deps.listMissing({ runId: input.runId, userId: input.userId, limit: COST_RECONCILE_MAX_PER_RUN });
		if (missing.length === 0) return result;
		result.checked = missing.length;
		const sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
		const fetchCost = deps.fetchCost ?? ((args) => fetchGenerationCost(args));
		const maxRetries = deps.maxRetries ?? COST_RECONCILE_MAX_RETRIES;
		let pending = missing;
		for (let attempt = 0; attempt <= maxRetries && pending.length > 0; attempt += 1) {
			await sleep(attempt === 0 ? (deps.delayMs ?? COST_RECONCILE_INITIAL_DELAY_MS) : (deps.retryDelayMs ?? COST_RECONCILE_RETRY_DELAY_MS));
			const notReady: typeof missing = [];
			for (const item of pending) {
				try {
					const cost = await fetchCost({ apiKey: input.apiKey, generationId: item.generationId, timeoutMs: COST_RECONCILE_TIMEOUT_MS });
					if (!cost.ok) {
						// 404: estatísticas ainda não prontas, tenta de novo na próxima rodada.
						if (cost.reason === "not_found") notReady.push(item);
						continue;
					}
					if (await deps.apply({ runId: input.runId, userId: input.userId, stepId: item.stepId, costUsd: cost.costUsd })) {
						result.reconciled += 1;
					}
				} catch {
					// um passo falhar não impede os outros
				}
			}
			pending = notReady;
		}
	} catch (error) {
		// Só o nome do erro: nada de objeto de request nem chave.
		console.error(`cost reconcile failed run=${input.runId} ${error instanceof Error ? error.name : "error"}`);
	}
	return result;
}
