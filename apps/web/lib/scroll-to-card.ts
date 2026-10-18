/**
 * "Abrir conversa de X" a partir de um card relayado: troca de bot e, quando o
 * fio dele carregar, rola até o card original e o destaca.
 */
let pending: { cardId: string; until: number } | null = null;

const WAIT_MS = 8_000;

export function requestScrollToCard(cardId: string, now = Date.now()): void {
	pending = { cardId, until: now + WAIT_MS };
}

/** O card pedido, se ainda vale (some depois de {WAIT_MS}); não consome. */
export function pendingScrollCard(now = Date.now()): string | null {
	if (!pending) return null;
	if (now > pending.until) {
		pending = null;
		return null;
	}
	return pending.cardId;
}

export function clearScrollToCard(): void {
	pending = null;
}
