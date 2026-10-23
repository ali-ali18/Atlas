import { classifyRunError } from "../errors.js";
import { SUMMARY_TIMEOUT_MS } from "./summary-compaction.js";

/**
 * Chamada do resumidor com UMA nova tentativa em falha passageira do provedor (5xx, 429, resposta vazia, rede).
 * O `/compact` roda dentro de uma requisição HTTP: as duas tentativas cabem num prazo total abaixo do proxy do
 * web (130 s) e do corte típico de borda (~100 s). Recusa de requisição (4xx) não repete: a cadeia de modelos da
 * manutenção já troca de candidato nesses casos.
 */

/** Prazo total das tentativas. */
export const SUMMARY_TOTAL_BUDGET_MS = 90_000;
/** Espera antes da segunda tentativa (o provedor costuma voltar em instantes). */
export const SUMMARY_RETRY_DELAY_MS = 1_500;
/** Com menos tempo que isto sobrando, um resumo grande não sai: não tenta de novo (ex.: a primeira estourou o prazo). */
export const SUMMARY_RETRY_MIN_MS = 30_000;

export type SummaryRetryOptions = {
	attemptTimeoutMs?: number;
	totalBudgetMs?: number;
	delayMs?: number;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	/** Avisa a nova tentativa (log do chamador; nunca o texto cru do provedor ao usuário). */
	onRetry?: (error: unknown) => void;
};

export function isRetryableSummaryError(error: unknown): boolean {
	return classifyRunError(error) === "transient";
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `call` recebe o prazo da tentativa. A falha da última tentativa sobe como veio. */
export async function callSummaryWithRetry<T>(call: (timeoutMs: number) => Promise<T>, options: SummaryRetryOptions = {}): Promise<T> {
	const now = options.now ?? Date.now;
	const budget = options.totalBudgetMs ?? SUMMARY_TOTAL_BUDGET_MS;
	const attemptTimeout = options.attemptTimeoutMs ?? SUMMARY_TIMEOUT_MS;
	const delay = options.delayMs ?? SUMMARY_RETRY_DELAY_MS;
	const startedAt = now();
	try {
		return await call(Math.min(attemptTimeout, budget));
	} catch (error) {
		if (!isRetryableSummaryError(error)) throw error;
		const remaining = budget - (now() - startedAt) - delay;
		if (remaining < SUMMARY_RETRY_MIN_MS) throw error;
		options.onRetry?.(error);
		await (options.sleep ?? defaultSleep)(delay);
		return call(Math.min(attemptTimeout, remaining));
	}
}
