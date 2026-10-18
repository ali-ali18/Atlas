/**
 * Heurística de orçamento de tokens para PT-BR (Fase 0 — sem tokenizador).
 *
 * Regra: ~1 token a cada `CHARS_PER_TOKEN` caracteres. Calibrar contra
 * `usage.promptTokens` real do OpenRouter quando houver telemetria.
 * Não usar para cobrança — só para guardas e gatilhos de higiene.
 */
export const TOKEN_ESTIMATE_CHARS_PER_TOKEN = 3.2;

export function estimateTokens(text: string): number {
	if (!text) return 0;
	return Math.max(1, Math.ceil(text.length / TOKEN_ESTIMATE_CHARS_PER_TOKEN));
}
