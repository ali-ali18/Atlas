/**
 * Link de uma notificação: abre o app na conversa (e, se houver, no cartão pendente).
 * O mesmo formato vale para a URL (`/?bot=ID&card=ID`) e para a mensagem do service worker.
 */

export type NotificationTarget = { botId: string; cardId: string | null };

export const NOTIFICATION_OPEN_MESSAGE = "open-conversation";

export function notificationUrl(botId: string, cardId?: string | null): string {
	const params = new URLSearchParams({ bot: botId });
	if (cardId) params.set("card", cardId);
	return `/?${params.toString()}`;
}

/** Lê o alvo da query string; null se não houver. */
export function parseNotificationTarget(search: string): NotificationTarget | null {
	const params = new URLSearchParams(search);
	const botId = params.get("bot")?.trim();
	if (!botId) return null;
	const cardId = params.get("card")?.trim();
	return { botId, cardId: cardId ? cardId : null };
}

/** Mensagem do service worker para uma janela já aberta. */
export function parseNotificationMessage(data: unknown): NotificationTarget | null {
	if (typeof data !== "object" || data === null) return null;
	const row = data as { type?: unknown; botId?: unknown; cardId?: unknown };
	if (row.type !== NOTIFICATION_OPEN_MESSAGE || typeof row.botId !== "string" || !row.botId) return null;
	return { botId: row.botId, cardId: typeof row.cardId === "string" && row.cardId ? row.cardId : null };
}

/** Query string sem os parâmetros da notificação (a URL fica limpa depois de abrir). */
export function stripNotificationParams(search: string): string {
	const params = new URLSearchParams(search);
	params.delete("bot");
	params.delete("card");
	const rest = params.toString();
	return rest ? `?${rest}` : "";
}
