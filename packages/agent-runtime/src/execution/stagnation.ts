/**
 * Estagnação por evidência (L6, primeira fatia): decisões seguidas sem nada
 * novo (ids, conteúdo, escrita concluída). Puro: recebe o estado, devolve o
 * próximo estado e, no máximo, um aviso por degrau e por sequência.
 */
export const STAGNATION_FIRST_NUDGE_AT = 3;
export const STAGNATION_FINAL_NUDGE_AT = 5;

export type StagnationState = { streak: number; nudged: 0 | 1 | 2 };

/** Texto voltado ao modelo: neutro, em inglês, sem exemplos de domínio. */
export const STAGNATION_NUDGE_CHANGE_APPROACH =
	"[Execution note] The last 3 steps produced no new information: no new items, no new content and no completed changes. Change your approach: use a different filter or field, request the next page if a result was truncated, or answer with what you already have and state clearly what is missing.";
export const STAGNATION_NUDGE_ANSWER_NOW =
	"[Execution note] Still no new information after 2 more steps. Stop calling tools and answer now with the evidence already gathered. List what could not be verified, and say what would be needed to close those gaps.";

export function advanceStagnation(
	state: StagnationState,
	novelty: number,
): { state: StagnationState; message: string | null } {
	if (novelty > 0) return { state: { streak: 0, nudged: 0 }, message: null };
	const streak = state.streak + 1;
	if (streak >= STAGNATION_FINAL_NUDGE_AT && state.nudged < 2) {
		return {
			state: { streak, nudged: 2 },
			message: STAGNATION_NUDGE_ANSWER_NOW,
		};
	}
	if (streak >= STAGNATION_FIRST_NUDGE_AT && state.nudged < 1) {
		return {
			state: { streak, nudged: 1 },
			message: STAGNATION_NUDGE_CHANGE_APPROACH,
		};
	}
	return { state: { streak, nudged: state.nudged }, message: null };
}
