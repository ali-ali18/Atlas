// Endereço do web para abrir a conversa no navegador (cartões que ainda não têm tela nativa). O web abre o bot por
// `?bot=<id>` (o mesmo parâmetro do toque numa notificação).
export function webChatUrl(serverUrl: string | null, botId: string, cardKey?: string): string | null {
	if (!serverUrl) return null;
	try {
		const url = new URL("/", serverUrl);
		url.searchParams.set("bot", botId);
		if (cardKey) url.searchParams.set("card", cardKey);
		return url.toString();
	} catch {
		return null;
	}
}
