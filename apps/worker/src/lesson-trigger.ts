/**
 * Quando vale agendar a revisão de lições depois de um run de chat. Decisão pura; o custo real (classificar a fala
 * do usuário, chamar o refletor) só acontece dentro do job, e só se houver sinal.
 */
export function shouldReviewLessons(input: {
	origin: string;
	hasBot: boolean;
	hasConversation: boolean;
	groupRun: boolean;
	onboardingRun: boolean;
	/** A conversa já tinha uma fala do bot antes deste pedido (a fala do usuário pode ser uma reação a ela). */
	priorAssistantTurn: boolean;
	failedToolCalls: number;
}): boolean {
	if (input.origin !== "chat" || !input.hasBot || !input.hasConversation || input.groupRun || input.onboardingRun) return false;
	return input.priorAssistantTurn || input.failedToolCalls > 0;
}
