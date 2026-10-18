/**
 * Ciclo limpo — Fase 2 (helpers puros).
 *
 * O chat/UI sempre vê o histórico total; só o pacote do LLM emagrece:
 * resumo obrigatório + cauda mínima, sem as 40 msgs. Sem resumo fresco,
 * o caller cai no caminho completo (nunca ciclo sem âncora).
 */

export const COMPACT_TAIL_KEEP = 6;

/**
 * Últimas N mensagens, preservando a ordem. Puro e testável; o caller
 * decide o que entra (já filtrado por papéis LLM).
 */
export function selectCompactTail<T extends { role: string }>(
	messages: readonly T[],
	keep: number = COMPACT_TAIL_KEEP,
): T[] {
	if (keep <= 0) return [];
	if (messages.length <= keep) return [...messages];
	return messages.slice(messages.length - keep);
}
