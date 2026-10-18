import { parseModelRef } from "@workspace/shared";
import { createAnthropicStreamChat } from "../anthropic/stream.js";
import { streamChatWithTools, type CompleteChatWithToolsParams, type CompleteChatWithToolsResult, type StreamChatWithToolsHandlers } from "../chat-tools.js";
import { ProviderApiError, classifyProviderHttpError } from "../provider-errors.js";
import { ChatgptProviderError } from "../responses/errors.js";
import { createChatgptStreamChat } from "../responses/stream.js";
import { OPENCODE_GO_BASE_URL, goEndpointUrl, goProtocolFor, type GoProtocol } from "./routing.js";

export const OPENCODE_USER_AGENT = "atlas-agent/0.1";

export type OpencodeGoStreamOptions = {
	getApiKey: () => Promise<string>;
	/** Protocolo do modelo, vindo do `/models` quando disponível; omitido = tabela de prefixos. */
	protocolOf?: (slug: string) => Promise<GoProtocol | null | undefined> | GoProtocol | null | undefined;
	/** Conversa estável (vira `x-opencode-session`); omitido = `sessionId` do run. */
	conversationId?: string;
	baseUrl?: string;
	userAgent?: string;
	/** Cabeçalho de auth do `/messages`: a documentação não especifica, então envia os dois por padrão. */
	messagesAuth?: "x-api-key" | "bearer" | "both";
	fetch?: typeof fetch;
};

/** Cabeçalhos que o OpenCode Go pede: UA próprio e sessão estável por conversa. Sem a chave. */
export function opencodeGoHeaders(params: Pick<CompleteChatWithToolsParams, "sessionId">, options: Pick<OpencodeGoStreamOptions, "conversationId" | "userAgent">): Record<string, string> {
	const session = (options.conversationId ?? params.sessionId)?.slice(0, 256);
	return { "User-Agent": options.userAgent ?? OPENCODE_USER_AGENT, ...(session ? { "x-opencode-session": session } : {}) };
}

/** Converte o erro do adaptador Responses (feito para o ChatGPT) no erro do OpenCode Go. */
function fromResponsesError(error: unknown): unknown {
	if (!(error instanceof ChatgptProviderError)) return error;
	if (error.code === "stream_interrupted" || error.code === "invalid_stream") return new ProviderApiError("opencode-go", 502, "stream_interrupted");
	if (error.code === "network_error") return new ProviderApiError("opencode-go", 502, "network_error");
	return classifyProviderHttpError("opencode-go", error.status, undefined);
}

/**
 * OpenCode Go: um único modelo `opencode-go/<slug>` roteado para o endpoint da sua família
 * (chat/completions, messages ou responses). Os três reutilizam os adaptadores existentes.
 */
export function createOpencodeGoStreamChat(options: OpencodeGoStreamOptions) {
	const baseUrl = options.baseUrl ?? OPENCODE_GO_BASE_URL;
	const messages = createAnthropicStreamChat({
		provider: "opencode-go",
		getApiKey: options.getApiKey,
		url: goEndpointUrl("messages", baseUrl),
		auth: options.messagesAuth ?? "both",
		headers: (params) => opencodeGoHeaders(params, options),
		costKind: "plan",
		fetch: options.fetch,
	});
	const responses = createChatgptStreamChat({
		getAccessToken: () => options.getApiKey(),
		fetch: options.fetch,
		endpoint: {
			url: goEndpointUrl("responses", baseUrl),
			slug: (model) => parseModelRef(model).slug,
			headers: (params) => opencodeGoHeaders(params, options),
		},
	});
	const dispatch = async (params: CompleteChatWithToolsParams, handlers: StreamChatWithToolsHandlers = {}): Promise<CompleteChatWithToolsResult> => {
		const { slug } = parseModelRef(params.model);
		const protocol = (await options.protocolOf?.(slug)) ?? goProtocolFor(slug);
		if (protocol === "google") throw new ProviderApiError("opencode-go", 400, "bad_request");
		if (protocol === "messages") return messages(params, handlers);
		if (protocol === "responses") {
			try {
				const result = await responses(params, handlers);
				return { ...result, usage: { ...result.usage, costKind: "plan" } };
			} catch (error) {
				throw fromResponsesError(error);
			}
		}
		return streamChatWithTools(
			{
				...params,
				apiKey: await options.getApiKey(),
				endpoint: {
					url: goEndpointUrl("chat", baseUrl),
					slug,
					provider: "opencode-go",
					headers: opencodeGoHeaders(params, options),
					costKind: "plan",
				},
			},
			handlers,
		);
	};
	// Rede de segurança: o catálogo do OpenCode Go quase nunca declara visão. Se o modelo recusar
	// (HTTP 400) uma requisição com imagem, repete UMA vez sem as imagens em vez de derrubar o run.
	return async (params: CompleteChatWithToolsParams, handlers: StreamChatWithToolsHandlers = {}): Promise<CompleteChatWithToolsResult> => {
		try {
			return await dispatch(params, handlers);
		} catch (error) {
			if (!(error instanceof ProviderApiError) || error.code !== "bad_request" || !hasImageParts(params.messages)) throw error;
			console.warn("opencode-go recusou a requisição com imagem; repetindo sem as imagens");
			return dispatch({ ...params, messages: withoutImages(params.messages) }, handlers);
		}
	};
}

function hasImageParts(messages: CompleteChatWithToolsParams["messages"]): boolean {
	return messages.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "image_url" || part.type === "file"));
}

/** Troca cada imagem por uma linha de texto; o resto da mensagem fica igual. */
export function withoutImages(messages: CompleteChatWithToolsParams["messages"]): CompleteChatWithToolsParams["messages"] {
	return messages.map((message) =>
		Array.isArray(message.content)
			? { ...message, content: message.content.map((part) => (part.type === "image_url" ? { type: "text" as const, text: "[image omitted: this model does not accept images]" } : part.type === "file" ? { type: "text" as const, text: "[document omitted: this model does not accept documents]" } : part)) }
			: message,
	);
}
