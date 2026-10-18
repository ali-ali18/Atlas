/**
 * Pedido de envio de mensagem ao chat aberto, vindo de outro ponto da tela
 * (por exemplo o botão "Testar de novo" do painel da sessão). Quem tem o
 * `sendMessage` (a conversa) escuta e envia como se o usuário tivesse digitado.
 */
export const CHAT_SEND_REQUEST_EVENT = "chat:send-request";

export function requestChatMessage(text: string): void {
	if (typeof window === "undefined" || !text.trim()) return;
	window.dispatchEvent(new CustomEvent<{ text: string }>(CHAT_SEND_REQUEST_EVENT, { detail: { text } }));
}

export function onChatMessageRequest(handler: (text: string) => void): () => void {
	if (typeof window === "undefined") return () => undefined;
	const listener = (event: Event) => {
		const text = (event as CustomEvent<{ text?: unknown }>).detail?.text;
		if (typeof text === "string" && text.trim()) handler(text);
	};
	window.addEventListener(CHAT_SEND_REQUEST_EVENT, listener);
	return () => window.removeEventListener(CHAT_SEND_REQUEST_EVENT, listener);
}
