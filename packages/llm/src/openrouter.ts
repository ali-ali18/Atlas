import type { ChatMessage } from "@workspace/shared";
import type { CompleteChatWithToolsParams, CompleteChatWithToolsResult, LlmMessage, StreamChatWithToolsHandlers } from "./chat-tools.js";
import { modelCallSignal } from "./signal.js";
import { OpenRouterError, readOpenRouterSse } from "./sse-stream.js";

const OPENROUTER_CHAT_URL =
	"https://openrouter.ai/api/v1/chat/completions";

export { OpenRouterError } from "./sse-stream.js";

export type CompleteChatParams = {
	messages: ChatMessage[];
	model: string;
	apiKey: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	/**
	 * Provedor por chave própria (Anthropic, OpenCode Go): o mesmo adaptador de stream dos runs, sem ferramentas.
	 * `model` é então a referência completa (`anthropic-direct/…`) e `apiKey` é ignorada pelo adaptador.
	 * Omitido = OpenRouter.
	 */
	via?: (params: CompleteChatWithToolsParams, handlers?: StreamChatWithToolsHandlers) => Promise<CompleteChatWithToolsResult>;
};

export type CompleteChatResult = {
	message: ChatMessage;
	model: string;
	usage?: {
		promptTokens?: number;
		completionTokens?: number;
		totalTokens?: number;
	};
};

type OpenRouterChatResponse = {
	id?: string;
	model?: string;
	choices?: Array<{
		message?: {
			role?: string;
			content?: string | null;
		};
	}>;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
	};
	error?: {
		message?: string;
		code?: number | string;
	};
};

export type StreamChatHandlers = {
	onDelta: (text: string) => void;
};

export async function streamChat(
	params: CompleteChatParams,
	handlers: StreamChatHandlers,
): Promise<CompleteChatResult> {
	const response = await fetch(OPENROUTER_CHAT_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${params.apiKey}`,
			"Content-Type": "application/json",
			"HTTP-Referer": "https://github.com/ali-ali18/Atlas",
			"X-Title": "Atlas",
		},
		body: JSON.stringify({
			model: params.model,
			messages: params.messages,
			stream: true,
		}),
		signal: modelCallSignal(params.signal, params.timeoutMs),
	});

	if (!response.ok) {
		let detail = `OpenRouter request failed with status ${response.status}`;
		try {
			const body = (await response.json()) as OpenRouterChatResponse;
			detail = body.error?.message ?? detail;
		} catch {
			// ignore parse errors
		}
		throw new OpenRouterError(detail, response.status);
	}

	if (!response.body) {
		throw new OpenRouterError("OpenRouter returned an empty stream body", 502);
	}

	let fullContent = "";
	let resolvedModel = params.model;
	let usage: CompleteChatResult["usage"];

	await readOpenRouterSse(response.body, (chunk) => {
		if (chunk.model) {
			resolvedModel = chunk.model;
		}
		if (chunk.usage) {
			usage = {
				promptTokens: chunk.usage.prompt_tokens,
				completionTokens: chunk.usage.completion_tokens,
				totalTokens: chunk.usage.total_tokens,
			};
		}
		const delta = chunk.choices?.[0]?.delta?.content;
		if (typeof delta === "string" && delta.length > 0) {
			fullContent += delta;
			handlers.onDelta(delta);
		}
	});

	if (fullContent.length === 0) {
		throw new OpenRouterError(
			"OpenRouter returned an empty assistant message",
			502,
		);
	}

	return {
		message: { role: "assistant", content: fullContent },
		model: resolvedModel,
		usage,
	};
}

/** Chamada de texto puro por um adaptador de provedor dos runs (sem duplicar HTTP). */
async function completeChatVia(params: CompleteChatParams & { via: NonNullable<CompleteChatParams["via"]> }): Promise<CompleteChatResult> {
	const result = await params.via({
		messages: params.messages as LlmMessage[],
		model: params.model,
		apiKey: params.apiKey,
		tools: [],
		signal: params.signal,
		timeoutMs: params.timeoutMs,
	});
	const content = result.message.content;
	if (typeof content !== "string" || content.length === 0) {
		throw new OpenRouterError("O provedor devolveu uma resposta vazia", 502);
	}
	const usage = result.usage;
	return {
		message: { role: "assistant", content },
		model: result.model || params.model,
		usage: usage ? { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, totalTokens: usage.totalTokens } : undefined,
	};
}

export async function completeChat(
	params: CompleteChatParams,
): Promise<CompleteChatResult> {
	if (params.via) return completeChatVia({ ...params, via: params.via });
	const response = await fetch(OPENROUTER_CHAT_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${params.apiKey}`,
			"Content-Type": "application/json",
			"HTTP-Referer": "https://github.com/ali-ali18/Atlas",
			"X-Title": "Atlas",
		},
		body: JSON.stringify({
			model: params.model,
			messages: params.messages,
		}),
		signal: modelCallSignal(params.signal, params.timeoutMs),
	});

	const body = (await response.json()) as OpenRouterChatResponse;

	if (!response.ok) {
		const detail =
			body.error?.message ??
			`OpenRouter request failed with status ${response.status}`;
		throw new OpenRouterError(detail, response.status);
	}

	const choice = body.choices?.[0];
	const content = choice?.message?.content;
	const role = choice?.message?.role;

	if (typeof content !== "string" || content.length === 0) {
		throw new OpenRouterError(
			"OpenRouter returned an empty assistant message",
			502,
		);
	}

	const assistantRole =
		role === "system" ||
		role === "user" ||
		role === "assistant" ||
		role === "tool"
			? role
			: "assistant";

	return {
		message: {
			role: assistantRole,
			content,
		},
		model: body.model ?? params.model,
		usage: body.usage
			? {
					promptTokens: body.usage.prompt_tokens,
					completionTokens: body.usage.completion_tokens,
					totalTokens: body.usage.total_tokens,
				}
			: undefined,
	};
}
