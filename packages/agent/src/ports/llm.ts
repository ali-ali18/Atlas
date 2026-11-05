// Porta `Llm`: acesso ao modelo por PAPEL, não por nome de modelo.
// Tipos próprios e mínimos (em vez de importar de `@workspace/llm`) para a porta
// ficar limpa e o motor não herdar o formato do legado; o adaptador de F1.10
// converte de/para `packages/llm`. A cadeia de reserva (429, queda no meio do
// run) NÃO mora aqui: o adaptador a implementa atrás desta mesma forma.

export type LlmRole = "main" | "helper" | "code" | "vision" | "sleep" | "classifier";

export type LlmToolSpec = {
	name: string;
	description: string;
	/** JSON Schema dos argumentos. */
	inputSchema: Record<string, unknown>;
};

export type LlmToolCall = { id: string; name: string; args: unknown };

export type LlmMessage =
	| { role: "system"; content: string }
	| { role: "user"; content: string }
	| { role: "assistant"; content: string; toolCalls?: LlmToolCall[] }
	| { role: "tool"; toolCallId: string; content: string };

export type LlmUsage = {
	inputTokens: number;
	outputTokens: number;
	cachedInputTokens?: number;
	/** US$; `undefined` quando o provedor não informa (nunca inventar). */
	costUsd?: number;
};

export type LlmChatRequest = {
	role: LlmRole;
	messages: LlmMessage[];
	tools?: LlmToolSpec[];
	/**
	 * "none": as tools continuam no pedido (prefixo e cache estáveis), mas o modelo não pode chamá-las.
	 * Usado no passo final de um limite. Omitido = "auto".
	 */
	toolChoice?: "auto" | "none";
	signal?: AbortSignal;
};

export type LlmStreamEvent =
	| { type: "text_delta"; text: string }
	| { type: "tool_call"; call: LlmToolCall }
	| {
			type: "done";
			finishReason: "stop" | "tool_calls" | "length" | "error";
			usage: LlmUsage;
			/** Provedor e modelo que de fato responderam (a cadeia pode ter trocado). */
			served: { provider: string; model: string };
	  }
	| { type: "notice"; message: string };

export interface Llm {
	chat(request: LlmChatRequest): AsyncIterable<LlmStreamEvent>;
	/** Janela de contexto (tokens) do modelo atual do papel; base da compactação. */
	contextWindow(role: LlmRole): Promise<number>;
}
