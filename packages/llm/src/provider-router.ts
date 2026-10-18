import { parseModelRef } from "@workspace/shared";
import { streamChatWithTools } from "./chat-tools.js";
export type ProviderStreamChat = typeof streamChatWithTools;

export function createProviderStreamChat(providers: {
	openrouter?: ProviderStreamChat;
	chatgpt: ProviderStreamChat;
	/** Anthropic direto (chave do usuário). */
	anthropic?: ProviderStreamChat;
	/** OpenCode Go (assinatura, chave do usuário). */
	opencodeGo?: ProviderStreamChat;
}): ProviderStreamChat {
	return (params, handlers) => {
		const { provider } = parseModelRef(params.model);
		// Metadados opacos nunca chegam a outro provedor/modelo.
		const messages = params.messages.map((message) => {
			if (!message.providerItems || (message.providerItems.provider === provider && message.providerItems.model === params.model)) return message;
			const { providerItems: discarded, ...clean } = message;
			return clean;
		});
		const cleanParams = messages.every((message, i) => message === params.messages[i]) ? params : { ...params, messages };
		const target =
			provider === "chatgpt"
				? providers.chatgpt
				: provider === "anthropic"
					? providers.anthropic
					: provider === "opencode-go"
						? providers.opencodeGo
						: (providers.openrouter ?? streamChatWithTools);
		if (!target) throw new Error("Provedor de modelo não configurado");
		return target(cleanParams, handlers);
	};
}
