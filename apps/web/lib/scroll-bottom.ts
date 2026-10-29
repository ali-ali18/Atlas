/** Folga de baixo da conversa: o composer (11rem) mais o espaço da barra de aprovação. */
export const COMPOSER_PAD_REM = 11;
/** Reserva mínima da barra enquanto há pedido pendente (linha de 44px + as camadas da pilha), estável. */
export const APPROVAL_BAR_RESERVE_PX = 96;

/**
 * Padding-bottom da conversa. Com pedido pendente a reserva é CONSTANTE (não depende de a barra estar visível),
 * para o scrollHeight não mudar quando o observer liga/desliga a barra no meio de uma rolagem até o fim.
 */
export function transcriptBottomPadding(hasPendingApproval: boolean, barHeight: number, dockHeight = 0): string | undefined {
	const dock = Math.max(0, Math.ceil(dockHeight));
	if (!hasPendingApproval) return dock > 0 ? `calc(${COMPOSER_PAD_REM}rem + ${dock}px)` : undefined;
	return `calc(${COMPOSER_PAD_REM}rem + ${Math.max(APPROVAL_BAR_RESERVE_PX, Math.ceil(barHeight)) + dock}px)`;
}

export function distanceFromBottom(metrics: { scrollHeight: number; scrollTop: number; clientHeight: number }): number {
	return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
}

/** A rolagem "até o fim" ficou curta (o layout mudou no meio dela) e precisa de um empurrão final. */
export function needsBottomCorrection(metrics: { scrollHeight: number; scrollTop: number; clientHeight: number }): boolean {
	return distanceFromBottom(metrics) > 2;
}
