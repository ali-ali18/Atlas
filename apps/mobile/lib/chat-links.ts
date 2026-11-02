// Endereço do web para abrir a conversa no navegador (cartões que ainda não têm tela nativa). O web abre o bot por
// `?bot=<id>` (o mesmo parâmetro do toque numa notificação, `apps/web/lib/notification-link.ts`). O `?card=` do web
// leva o id da MENSAGEM gravada, que o app nem sempre tem (cartão ao vivo ainda não gravado), então o link abre o
// chat do bot e não o cartão. O prefixo de caminho do servidor (Atlas atrás de `/atlas`, por exemplo) é preservado.
export function webChatUrl(serverUrl: string | null, botId: string): string | null {
	if (!serverUrl) return null;
	try {
		const url = new URL(serverUrl);
		url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
		url.search = "";
		url.hash = "";
		url.searchParams.set("bot", botId);
		return url.toString();
	} catch {
		return null;
	}
}
