import { normalizeFinishReason } from "@workspace/shared";
import type {
	CompleteChatWithToolsParams,
	CompleteChatWithToolsResult,
	LlmToolCall,
	LlmUsage,
	StreamChatWithToolsHandlers,
} from "../chat-tools.js";
import { withLlmStepRetry } from "../config.js";
import { abortable, createDecisionBudget } from "../decision-budget.js";
import { ProviderApiError, classifyProviderHttpError, isRetryableProviderError, type KeyProviderName } from "../provider-errors.js";
import { createCallTimer } from "../timing.js";
import { configuredCacheTtl } from "../prompt-cache.js";
import { anthropicRequestBody } from "./convert.js";

export const ANTHROPIC_API_BASE_URL = "https://api.anthropic.com";
export const ANTHROPIC_VERSION = "2023-06-01";

type Usage = {
	input_tokens?: number;
	output_tokens?: number;
	cache_creation_input_tokens?: number;
	cache_read_input_tokens?: number;
};
export type AnthropicEvent = {
	type: string;
	index?: number;
	message?: { id?: string; model?: string; usage?: Usage };
	content_block?: { type?: string; id?: string; name?: string };
	delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string | null };
	usage?: Usage;
	error?: { type?: string; message?: string };
};

/** Lê o SSE da Messages API até `message_stop`; fim do corpo antes disso é erro. */
export async function readAnthropicSse(
	body: ReadableStream<Uint8Array>,
	onEvent: (event: AnthropicEvent) => void,
	options: { signal?: AbortSignal; provider?: KeyProviderName } = {},
): Promise<void> {
	const provider = options.provider ?? "anthropic";
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		for (;;) {
			const { done, value } = await abortable(reader.read(), options.signal);
			if (done) throw new ProviderApiError(provider, 502, "stream_interrupted");
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed.startsWith("data:")) continue;
				const payload = trimmed.slice(5).trim();
				if (!payload || payload === "[DONE]") continue;
				let event: AnthropicEvent;
				try {
					event = JSON.parse(payload) as AnthropicEvent;
				} catch {
					continue;
				}
				if (event.type === "error") {
					const kind = event.error?.type ?? "";
					throw new ProviderApiError(provider, kind === "overloaded_error" ? 529 : 502, kind === "overloaded_error" ? "unavailable" : kind === "rate_limit_error" ? "rate_limited" : "upstream_error");
				}
				onEvent(event);
				if (event.type === "message_stop") return;
			}
		}
	} finally {
		try {
			void reader.cancel().catch(() => undefined);
		} catch {
			// Já fechado.
		}
		try {
			reader.releaseLock();
		} catch {
			// Lock já solto.
		}
	}
}

/** Entrada total = entrada nova + leitura + escrita de cache (mesma convenção do OpenAI `prompt_tokens`). */
export function anthropicUsage(input: Usage, output: Usage, costKind?: "plan"): LlmUsage {
	const read = input.cache_read_input_tokens ?? 0;
	const write = input.cache_creation_input_tokens ?? 0;
	const fresh = input.input_tokens ?? 0;
	const promptTokens = fresh + read + write;
	const completionTokens = output.output_tokens ?? input.output_tokens ?? 0;
	return {
		promptTokens,
		completionTokens,
		totalTokens: promptTokens + completionTokens,
		cachedTokens: read,
		cacheWriteTokens: write,
		// Sem tabela de preços: registra tokens e marca o custo como desconhecido, nunca 0.
		...(costKind ? { costKind } : { costUnknown: true }),
	};
}

export type AnthropicStreamOptions = {
	provider: KeyProviderName;
	getApiKey: () => Promise<string>;
	/** URL completa do endpoint de mensagens. */
	url: string;
	auth: "x-api-key" | "bearer" | "both";
	/** Cabeçalhos extras por chamada (User-Agent, sessão). */
	headers?: (params: CompleteChatWithToolsParams) => Record<string, string>;
	fetch?: typeof fetch;
	costKind?: "plan";
};

/** Cabeçalho beta do cache de 1 hora (aceito e ignorado quando a validade já é geral); junta ao beta que o chamador já mandou. */
export const ANTHROPIC_EXTENDED_CACHE_BETA = "extended-cache-ttl-2025-04-11";
function cacheTtlBeta(extra: Record<string, string> | undefined, active: boolean): Record<string, string> {
	if (!active || !configuredCacheTtl()) return {};
	const existing = Object.entries(extra ?? {}).find(([name]) => name.toLowerCase() === "anthropic-beta")?.[1];
	return { "anthropic-beta": existing && !existing.includes(ANTHROPIC_EXTENDED_CACHE_BETA) ? `${existing},${ANTHROPIC_EXTENDED_CACHE_BETA}` : existing ?? ANTHROPIC_EXTENDED_CACHE_BETA };
}

export function anthropicAuthHeaders(auth: AnthropicStreamOptions["auth"], key: string): Record<string, string> {
	return {
		...(auth === "x-api-key" || auth === "both" ? { "x-api-key": key } : {}),
		...(auth === "bearer" || auth === "both" ? { Authorization: `Bearer ${key}` } : {}),
	};
}

/** Adaptador do formato interno (chat + tools) para a Messages API da Anthropic, com SSE. */
export function createAnthropicStreamChat(options: AnthropicStreamOptions) {
	return async (params: CompleteChatWithToolsParams, handlers: StreamChatWithToolsHandlers = {}): Promise<CompleteChatWithToolsResult> => {
		const slug = params.model.slice(params.model.indexOf("/") + 1);
		const timer = createCallTimer(params.model, params.clock);
		const budget = createDecisionBudget(params);
		const fetchFn = options.fetch ?? fetch;
		let delivered = false;
		try {
			return await withLlmStepRetry(
				async () => {
					const attempt = budget.attempt();
					try {
						const key = await abortable(options.getApiKey(), attempt.signal);
						// A validade de 1 hora é só da Anthropic direta; proxies de terceiros ficam nos 5 minutos de sempre.
						const oneHour = options.provider === "anthropic";
						const send = (cache: boolean, ttl?: false) =>
							abortable(
								fetchFn(options.url, {
									method: "POST",
									headers: {
										...anthropicAuthHeaders(options.auth, key),
										"anthropic-version": ANTHROPIC_VERSION,
										"content-type": "application/json",
										accept: "text/event-stream",
										...(options.headers?.(params) ?? {}),
										...cacheTtlBeta(options.headers?.(params), cache && ttl !== false && oneHour),
									},
									body: JSON.stringify(anthropicRequestBody(params, slug, { cache, ...(ttl === false || !oneHour ? { ttl: false as const } : {}) })),
									redirect: "error",
									signal: attempt.signal,
								}),
								attempt.signal,
							);
						let response: Response;
						try {
							response = await send(true);
							if (response.status === 400) {
								const detail = await abortable(response.clone().text(), attempt.signal).catch(() => "");
								// Validade de 1 hora recusada: repete com a de 5 minutos; qualquer outro erro de cache_control, sem breakpoints.
								if (/cache_control|ttl/i.test(detail)) response = oneHour && configuredCacheTtl() && /ttl/i.test(detail) ? await send(true, false) : await send(false);
							}
						} catch (error) {
							attempt.signal.throwIfAborted();
							if (error instanceof ProviderApiError) throw error;
							throw new ProviderApiError(options.provider, 502, "network_error");
						}
						if (!response.ok) {
							let payload: unknown;
							try {
								payload = await abortable(response.json(), attempt.signal);
							} catch {
								attempt.signal.throwIfAborted();
							}
							throw classifyProviderHttpError(options.provider, response.status, payload, response.headers);
						}
						if (!response.body) throw new ProviderApiError(options.provider, 502, "stream_interrupted");

						let text = "";
						let model = params.model;
						let stopReason: string | null | undefined;
						let start: Usage = {};
						let last: Usage = {};
						const blocks = new Map<number, { kind: string; id: string; name: string; json: string }>();
						await readAnthropicSse(
							response.body,
							(event) => {
								if (event.type !== "ping") {
									attempt.markUseful();
									timer.markFirstChunk();
								}
								if (event.type === "message_start") {
									start = event.message?.usage ?? {};
									if (event.message?.model) model = `${params.model.slice(0, params.model.indexOf("/") + 1)}${event.message.model}`;
								} else if (event.type === "content_block_start" && event.index !== undefined) {
									const block = event.content_block ?? {};
									blocks.set(event.index, { kind: block.type ?? "", id: block.id ?? "", name: block.name ?? "", json: "" });
								} else if (event.type === "content_block_delta" && event.index !== undefined) {
									const delta = event.delta ?? {};
									if (delta.type === "text_delta" && delta.text) {
										text += delta.text;
										if (handlers.onDelta) delivered = true;
										handlers.onDelta?.(delta.text);
									} else if (delta.type === "input_json_delta" && delta.partial_json) {
										const block = blocks.get(event.index);
										if (block) block.json += delta.partial_json;
									}
								} else if (event.type === "message_delta") {
									stopReason = event.delta?.stop_reason ?? stopReason;
									last = { ...last, ...(event.usage ?? {}) };
								}
							},
							{ signal: attempt.signal, provider: options.provider },
						);
						const toolCalls: LlmToolCall[] = [...blocks.entries()]
							.sort((a, b) => a[0] - b[0])
							.map(([, block]) => block)
							.filter((block) => block.kind === "tool_use" && block.name)
							.map((block) => ({
								id: block.id || `call_${Math.random().toString(36).slice(2)}`,
								type: "function" as const,
								function: { name: block.name, arguments: block.json || "{}" },
							}));
						return {
							message: { role: "assistant", content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
							model,
							usage: anthropicUsage({ ...start, ...last, input_tokens: last.input_tokens ?? start.input_tokens }, { ...start, ...last }, options.costKind),
							timing: timer.finish(model),
							finishReason: normalizeFinishReason(stopReason),
							appliedOutputCap: true,
						};
					} finally {
						attempt.dispose();
					}
				},
				{
					signal: budget.signal,
					onRetry: timer.onRetry,
					retryIf: (error) => !delivered && isRetryableProviderError(error),
				},
			);
		} finally {
			budget.dispose();
		}
	};
}
