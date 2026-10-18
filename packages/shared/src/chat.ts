/** Papéis de mensagem no chat (compatível com APIs OpenAI/OpenRouter). */
export type ChatRole = "system" | "user" | "assistant" | "tool";

export const LLM_CHAT_ROLES: readonly ChatRole[] = [
	"system",
	"user",
	"assistant",
	"tool",
];

export function isLlmChatRole(role: string): role is ChatRole {
	return (LLM_CHAT_ROLES as readonly string[]).includes(role);
}

export type ChatMessage = {
	role: ChatRole;
	content: string;
};

/** Corpo esperado pelo endpoint `POST /v1/chat` da API Atlas. */
export type ChatCompletionRequest = {
	messages: ChatMessage[];
	model?: string;
	/** Quando informado, carrega histórico + fatos de perfil e persiste o turno. */
	conversationId?: string;
	/** Bot associado ao turno (define a memória por bot). */
	botId?: string;
};

export type ChatCompletionUsage = {
	promptTokens?: number;
	completionTokens?: number;
	totalTokens?: number;
};

/** Resposta do endpoint de chat completion da API Atlas. */
export type ChatCompletionResponse = {
	message: ChatMessage;
	model: string;
	usage?: ChatCompletionUsage;
};
