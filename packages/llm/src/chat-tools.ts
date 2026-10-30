import { abortable, createDecisionBudget } from "./decision-budget.js";
import { OpenRouterError, readOpenRouterSse } from "./sse-stream.js";
import {
	applyCacheBreakpoints,
	configuredCacheTtl,
	supportsExplicitPromptCache,
	type PromptCacheTtl,
} from "./prompt-cache.js";
import {
	readOpenRouterFallbackModels,
	withLlmStepRetry,
	isRetryableLlmError,
} from "./config.js";
import { createCallTimer, type LlmCallTiming } from "./timing.js";
import { canonicalMessage, demoteSystemNotes, remapStableIndex } from "./system-notes.js";
import { normalizeFinishReason, type FinishReason } from "@workspace/shared";
import {
	classifyProviderHttpError,
	isRetryableProviderError,
	type KeyProviderName,
} from "./provider-errors.js";

/**
 * F4 — corpo com fallback nativo do OpenRouter: tenta o `model` e depois
 * cada `OPENROUTER_FALLBACK_MODELS`, sem trocar de código no 429.
 */
/**
 * Claude via OpenRouter: notas de sistema fora do começo viram texto delimitado na própria posição (o provedor
 * junta todo `system` no cabeçalho, e uma nota nova ali invalida o prefixo) e os breakpoints de cache entram
 * sobre essa lista. Outros modelos seguem sem mudança.
 */
function claudeCacheMessages(params: CompleteChatWithToolsParams, options: { cache?: boolean; ttl?: PromptCacheTtl | false }): LlmMessage[] {
	if (options.cache === false || !supportsExplicitPromptCache(params.model)) return params.messages;
	const demoted = demoteSystemNotes(params.messages);
	return applyCacheBreakpoints(demoted.messages.map(canonicalMessage), undefined, {
		stableIndex: remapStableIndex(params.cacheStableIndex, demoted.positions),
		ttl: (options.ttl === undefined ? configuredCacheTtl() : options.ttl) || undefined,
	});
}

export function chatRequestBody(
	params: CompleteChatWithToolsParams,
	stream: boolean,
	options: { cache?: boolean; ttl?: PromptCacheTtl | false } = {},
) {
	// O catálogo de fallbacks de texto não garante visão. Uma imagem só segue
	// para o modelo escolhido e verificado pelo caller.
	const hasImage = params.messages.some(
		(message) =>
			Array.isArray(message.content) &&
			message.content.some((part) => part.type === "image_url" || part.type === "file"),
	);
	const fallbacks = hasImage
		? []
		: (params.fallbackModels ?? readOpenRouterFallbackModels()).filter(
				(model) => model !== params.model,
			);
	const maxTokens = params.maxOutputTokens;
	const requestedReasoningTokens =
		params.reasoningMaxTokens ??
		(process.env.LLM_REASONING_MAX_TOKENS
			? Number(process.env.LLM_REASONING_MAX_TOKENS)
			: undefined);
	for (const value of [maxTokens, requestedReasoningTokens]) {
		if (
			value !== undefined &&
			(!Number.isInteger(value) || value < 1 || value > 1_000_000)
		)
			throw new RangeError("Invalid generation token budget");
	}
	// O saldo do run pode reduzir a saída; reserve ao menos metade para ela.
	const reasoningTokens =
		requestedReasoningTokens === undefined
			? undefined
			: maxTokens === undefined
				? requestedReasoningTokens
				: maxTokens < 2
					? undefined
					: Math.min(requestedReasoningTokens, Math.floor(maxTokens / 2));
	return {
		...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
		...(reasoningTokens !== undefined
			? { reasoning: { max_tokens: reasoningTokens } }
			: {}),
		parallel_tool_calls: true,
		model: params.model,
		...(fallbacks.length > 0 ? { models: [params.model, ...fallbacks] } : {}),
		messages: claudeCacheMessages(params, options),
		tools: params.tools,
		tool_choice: params.toolChoice ?? "auto",
		stream,
		// Contabilidade de uso (cost, cached_tokens). O OpenRouter já devolve por
		// padrão; o flag antigo mantém contas/rotas mais velhas funcionando.
		usage: { include: true },
		// Roteamento sticky: mantém o mesmo endpoint e portanto o cache quente.
		...(params.sessionId ? { session_id: params.sessionId.slice(0, 256) } : {}),
	};
}

/** Corpo mínimo OpenAI-compatível para endpoints que não são o OpenRouter (sem extensões dele). */
function endpointChatBody(params: CompleteChatWithToolsParams, stream: boolean) {
	const endpoint = params.endpoint!;
	const messages = params.messages.map((message) => {
		const { providerItems: _opaque, ...rest } = message;
		if (!Array.isArray(rest.content)) return rest;
		return {
			...rest,
			content: rest.content.map((part) => {
				if (part.type !== "text" || !part.cache_control) return part;
				const { cache_control: _drop, ...text } = part;
				return text;
			}),
		};
	});
	return {
		model: endpoint.slug,
		messages,
		...(params.tools.length ? { tools: params.tools, tool_choice: params.toolChoice ?? "auto" } : {}),
		...(params.maxOutputTokens !== undefined ? { max_tokens: params.maxOutputTokens } : {}),
		stream,
		...(stream ? { stream_options: { include_usage: true } } : {}),
	};
}

/** Erro HTTP do endpoint: provedor por chave tem mensagem fixa; o OpenRouter mantém a do upstream. */
function httpFailure(params: CompleteChatWithToolsParams, status: number, body: OpenRouterToolResponse | undefined, headers?: { get(name: string): string | null } | null): Error {
	if (params.endpoint) return classifyProviderHttpError(params.endpoint.provider, status, body, headers);
	return new OpenRouterError(body?.error?.message ?? `OpenRouter request failed with status ${status}`, status);
}

/**
 * POST com cache de prompt; se o provider recusar `cache_control` (400),
 * repete UMA vez sem os breakpoints em vez de derrubar o run.
 */
async function postChat(
	params: CompleteChatWithToolsParams,
	stream: boolean,
	requests: { count: number },
): Promise<Response> {
	const send = (cache: boolean, ttl?: false) => {
		if (requests.count >= 2)
			throw new Error("LLM request attempt limit exceeded");
		requests.count += 1;
		return abortable(
			fetch(params.endpoint?.url ?? OPENROUTER_CHAT_URL, {
				method: "POST",
				headers: params.endpoint
					? { Authorization: `Bearer ${params.apiKey}`, "Content-Type": "application/json", ...params.endpoint.headers }
					: OPENROUTER_TOOL_HEADERS(params.apiKey),
				body: JSON.stringify(params.endpoint ? endpointChatBody(params, stream) : chatRequestBody(params, stream, { cache, ...(ttl === false ? { ttl } : {}) })),
				signal: params.signal,
			}),
			params.signal,
		);
	};
	const httpAttempt = await send(true);
	if (
		params.endpoint ||
		httpAttempt.status !== 400 ||
		!supportsExplicitPromptCache(params.model)
	) {
		return httpAttempt;
	}
	const detail = await abortable(httpAttempt.clone().text(), params.signal);
	if (!/cache_control|cache control|ttl/i.test(detail)) return httpAttempt;
	// Validade de 1 hora recusada: repete com a de 5 minutos, que o provedor sempre aceita; senão, sem breakpoints.
	return configuredCacheTtl() && /ttl/i.test(detail) ? send(true, false) : send(false);
}

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";

export type LlmContentPart =
	| { type: "text"; text: string; cache_control?: { type: "ephemeral"; ttl?: "5m" | "1h" } }
	| { type: "image_url"; image_url: { url: string } }
	/** Documento (PDF) para o modelo ler nativamente; `file_data` é um Data URL base64. Só vai a quem lê PDF. */
	| { type: "file"; file: { filename: string; file_data: string } }
	/** Forma de ARMAZENAMENTO: PDF anexado pelo usuário; o runtime expande para `file` na chamada ao modelo. */
	| { type: "file_ref"; artifactId: string; filename: string }
	/**
	 * Forma de ARMAZENAMENTO interna: referência a screenshot persistido como
	 * artefato. Nunca vai para o provider — o runtime expande para `image_url`
	 * com Data URL só na hora da chamada ao modelo.
	 */
	| { type: "screenshot_ref"; artifactId: string }
	| {
			type: "image_ref";
			artifactId: string;
			name?: string;
			description?: string;
	  };

export type LlmToolCall = {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
};

/** Histórico opaco, vinculado ao modelo que produziu os itens. */
export type LlmProviderItems = {
	provider: "chatgpt";
	model: string;
	items: Record<string, unknown>[];
};

/** Mensagem no formato OpenAI/OpenRouter (aceita conteúdo multimodal). */
export type LlmMessage = {
	role: "system" | "user" | "assistant" | "tool";
	content: string | LlmContentPart[] | null;
	tool_calls?: LlmToolCall[];
	tool_call_id?: string;
	providerItems?: LlmProviderItems;
};

export type ChatTool = {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: {
			type: "object";
			properties: Record<string, unknown>;
			required?: string[];
		};
	};
};

export type CompleteChatWithToolsParams = {
	messages: LlmMessage[];
	model: string;
	apiKey: string;
	tools: ChatTool[];
	toolChoice?: "auto" | "none" | "required";
	/** Cancela a chamada (ex.: run cancelado no meio do stream). */
	signal?: AbortSignal;
	/** Teto por chamada; sem ele, um stream travado segura o run para sempre. */
	timeoutMs?: number;
	/** Teto total após o stream começar a produzir (geração longa de arquivo). */
	progressTimeoutMs?: number;
	deadlineAtMs?: number;
	firstEventTimeoutMs?: number;
	idleTimeoutMs?: number;
	maxOutputTokens?: number;
	reasoningMaxTokens?: number;
	/** Modelos de reserva do OpenRouter. Omitido = `OPENROUTER_FALLBACK_MODELS`. */
	fallbackModels?: string[];
	/** Id estável do run: o OpenRouter roteia p/ o mesmo endpoint (cache quente). */
	sessionId?: string;
	/** Fim do prefixo estável do histórico (índice em `messages`): vira um breakpoint extra. */
	cacheStableIndex?: number;
	/** Relógio injetável (ms) para medir TTFT e duração em teste. */
	clock?: () => number;
	/**
	 * Endpoint OpenAI-compatível que não é o OpenRouter (ex.: OpenCode Go).
	 * `apiKey` vira Bearer; `slug` é o id do modelo no provedor; `headers` são extras (UA, sessão).
	 */
	endpoint?: {
		url: string;
		slug: string;
		provider: KeyProviderName;
		headers?: Record<string, string>;
		/** `plan`: assinatura sem preço por chamada. */
		costKind?: "plan";
	};
};

export type LlmUsage = {
	reasoningTokens?: number;
	costKind?: "plan";
	promptTokens?: number;
	completionTokens?: number;
	totalTokens?: number;
	/** Tokens do prompt lidos do cache (custo ~0,1x no Anthropic). */
	cachedTokens?: number;
	/** Tokens gravados no cache neste passo (~1,25x). */
	cacheWriteTokens?: number;
	/** Custo real do passo em USD (OpenRouter `usage.cost`). */
	costUsd?: number;
	/** true quando o provider não informou `usage.cost`: custo desconhecido, nunca 0. */
	costUnknown?: boolean;
};

export type CompleteChatWithToolsResult = {
	fallbackFrom?: string;
	/** false quando o provedor não aceita teto de saída. */
	appliedOutputCap?: boolean;
	message: {
		role: "assistant";
		content: string | null;
		providerItems?: LlmProviderItems;
		tool_calls?: LlmToolCall[];
	};
	model: string;
	usage?: LlmUsage;
	/** Id da geração no OpenRouter (resposta `id`), para reconciliar o custo depois. */
	generationId?: string;
	/** F0: tempo total, TTFT, tentativas e modelo servido da chamada. */
	timing?: LlmCallTiming;
	/** L18: motivo de término normalizado; `incomplete` = o stream acabou sem `finish_reason`. */
	finishReason?: FinishReason;
};

type OpenRouterToolResponse = {
	id?: string;
	model?: string;
	choices?: Array<{
		message?: {
			role?: string;
			content?: string | null;
			tool_calls?: Array<{
				id?: string;
				type?: string;
				function?: { name?: string; arguments?: string };
			}>;
		};
		finish_reason?: string | null;
	}>;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
		/** Custo em créditos (USD) cobrado pelo OpenRouter. */
		cost?: number;
		prompt_tokens_details?: {
			cached_tokens?: number;
			cache_write_tokens?: number;
		};
	};
	error?: { message?: string };
};

type OpenRouterStreamChunk = {
	id?: string;
	model?: string;
	choices?: Array<{
		delta?: {
			content?: string | null;
			tool_calls?: Array<{
				index?: number;
				id?: string;
				type?: string;
				function?: { name?: string; arguments?: string };
			}>;
		};
	}>;
	usage?: OpenRouterToolResponse["usage"];
};

export type StreamChatWithToolsHandlers = {
	onDelta?: (text: string) => void;
};

const OPENROUTER_TOOL_HEADERS = (apiKey: string) => ({
	Authorization: `Bearer ${apiKey}`,
	"Content-Type": "application/json",
	"HTTP-Referer": "https://github.com/ali-ali18/Atlas",
	"X-Title": "Atlas",
});

function toolCallsFromResponse(
	raw: NonNullable<
		NonNullable<OpenRouterToolResponse["choices"]>[number]["message"]
	>["tool_calls"],
): LlmToolCall[] {
	const toolCalls: LlmToolCall[] = [];
	for (const call of raw ?? []) {
		if (!call.function?.name) continue;
		toolCalls.push({
			id: call.id ?? `call_${Math.random().toString(36).slice(2)}`,
			type: "function",
			function: {
				name: call.function.name,
				arguments: call.function.arguments ?? "{}",
			},
		});
	}
	return toolCalls;
}

export function usageFrom(
	raw: OpenRouterToolResponse["usage"],
): LlmUsage | undefined {
	if (!raw) return undefined;
	const details = raw.prompt_tokens_details;
	return {
		promptTokens: raw.prompt_tokens,
		completionTokens: raw.completion_tokens,
		totalTokens: raw.total_tokens,
		...(typeof details?.cached_tokens === "number"
			? { cachedTokens: details.cached_tokens }
			: {}),
		...(typeof details?.cache_write_tokens === "number"
			? { cacheWriteTokens: details.cache_write_tokens }
			: {}),
		...(typeof raw.cost === "number" &&
		Number.isFinite(raw.cost) &&
		raw.cost >= 0
			? { costUsd: raw.cost }
			: { costUnknown: true }),
	};
}

/** Só aceita ids simples (vão para a URL da reconciliação). */
export function sanitizeGenerationId(value: unknown): string | undefined {
	return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value)
		? value
		: undefined;
}

/** Assinatura (plano) não tem preço por chamada: marca `plan` em vez de custo desconhecido. */
function withEndpointCost(params: CompleteChatWithToolsParams, usage: LlmUsage): LlmUsage {
	if (params.endpoint?.costKind !== "plan") return usage;
	const { costUnknown: _unknown, costUsd: _usd, ...rest } = usage;
	return { ...rest, costKind: "plan" };
}

/** Sem chunk de usage no stream o custo também é desconhecido. */
const UNKNOWN_COST_USAGE: LlmUsage = { costUnknown: true };

export async function streamChatWithTools(
	params: CompleteChatWithToolsParams,
	handlers: StreamChatWithToolsHandlers = {},
): Promise<CompleteChatWithToolsResult> {
	const timer = createCallTimer(params.model, params.clock);
	const budget = createDecisionBudget(params);
	const requests = { count: 0 };
	let delivered = false;
	try {
		return await withLlmStepRetry(
			async () => {
				const attempt = budget.attempt();
				try {
					// F4 — retry por passo (429/5xx/créditos) antes de propagar ao run.
					const response = await (async () => {
						const httpAttempt = await postChat(
							{ ...params, signal: attempt.signal },
							true,
							requests,
						);
						if (!httpAttempt.ok) {
							let body: OpenRouterToolResponse | undefined;
							try {
								body = (await abortable(
									httpAttempt.json(),
									attempt.signal,
								)) as OpenRouterToolResponse;
							} catch {
								// ignore
							}
							throw httpFailure(params, httpAttempt.status, body, httpAttempt.headers);
						}
						return httpAttempt;
					})();

					if (!response.body) {
						throw new OpenRouterError(
							"OpenRouter returned an empty stream body",
							502,
						);
					}

					let content = "";
					let resolvedModel = params.model;
					let usage: LlmUsage | undefined;
					let generationId: string | undefined;
					let finishRaw: string | null | undefined;
					const toolCallParts = new Map<
						number,
						{ id: string; name: string; args: string }
					>();

					await readOpenRouterSse(
						response.body,
						(chunk) => {
							const delta = chunk.choices?.[0]?.delta;
							if (
								delta?.content ||
								delta?.tool_calls?.length ||
								delta?.reasoning ||
								delta?.reasoning_details?.length ||
								chunk.usage
							) {
								attempt.markUseful();
								timer.markFirstChunk();
							}
							if (chunk.model) resolvedModel = chunk.model;
							generationId = sanitizeGenerationId(chunk.id) ?? generationId;
							usage = usageFrom(chunk.usage) ?? usage;
							finishRaw = chunk.choices?.[0]?.finish_reason ?? finishRaw;
							if (!delta) return;

							if (
								typeof delta.content === "string" &&
								delta.content.length > 0
							) {
								content += delta.content;
								if (handlers.onDelta) delivered = true;
								handlers.onDelta?.(delta.content);
							}

							for (const part of delta.tool_calls ?? []) {
								const index = part.index ?? 0;
								const current = toolCallParts.get(index) ?? {
									id: "",
									name: "",
									args: "",
								};
								if (part.id) current.id = part.id;
								if (part.function?.name) current.name = part.function.name;
								if (part.function?.arguments) {
									current.args += part.function.arguments;
								}
								toolCallParts.set(index, current);
							}
						},
						{ signal: attempt.signal, requireDone: true },
					);

					const toolCalls: LlmToolCall[] = [];
					for (const part of [...toolCallParts.entries()]
						.sort((a, b) => a[0] - b[0])
						.map(([, value]) => value)) {
						if (!part.name) continue;
						toolCalls.push({
							id: part.id || `call_${Math.random().toString(36).slice(2)}`,
							type: "function",
							function: { name: part.name, arguments: part.args || "{}" },
						});
					}

					return {
						message: {
							role: "assistant",
							content: content.length > 0 ? content : null,
							tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
						},
						model: resolvedModel,
						usage: withEndpointCost(params, usage ?? UNKNOWN_COST_USAGE),
						...((generationId ?? sanitizeGenerationId(response.headers?.get?.("x-generation-id")))
							? { generationId: generationId ?? sanitizeGenerationId(response.headers.get("x-generation-id")) }
							: {}),
						timing: timer.finish(resolvedModel),
						finishReason: normalizeFinishReason(finishRaw),
					};
				} finally {
					attempt.dispose();
				}
			},
			{
				signal: budget.signal,
				onRetry: timer.onRetry,
				retryIf: (error) => !delivered && (params.endpoint ? isRetryableProviderError(error) : isRetryableLlmError(error)),
			},
		);
	} finally {
		budget.dispose();
	}
}

export async function completeChatWithTools(
	params: CompleteChatWithToolsParams,
): Promise<CompleteChatWithToolsResult> {
	const timer = createCallTimer(params.model, params.clock);
	const budget = createDecisionBudget(params);
	const requests = { count: 0 };
	try {
		return await withLlmStepRetry(
			async () => {
				const attempt = budget.attempt();
				try {
					// F4 — retry por passo (429/5xx/créditos) antes de propagar ao run.
					const response = await (async () => {
						const httpAttempt = await postChat(
							{ ...params, signal: attempt.signal },
							false,
							requests,
						);
						if (!httpAttempt.ok) {
							let errorBody: OpenRouterToolResponse | undefined;
							try {
								errorBody = (await abortable(
									httpAttempt.json(),
									attempt.signal,
								)) as OpenRouterToolResponse;
							} catch {
								// ignore
							}
							throw httpFailure(params, httpAttempt.status, errorBody, httpAttempt.headers);
						}
						return httpAttempt;
					})();

					const body = (await abortable(
						response.json(),
						attempt.signal,
					)) as OpenRouterToolResponse;
					attempt.markUseful();
					const message = body.choices?.[0]?.message;
					if (!message) {
						throw new OpenRouterError("OpenRouter returned no message", 502);
					}

					const toolCalls = toolCallsFromResponse(message.tool_calls);

					return {
						message: {
							role: "assistant",
							content:
								typeof message.content === "string" ? message.content : null,
							tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
						},
						model: body.model ?? params.model,
						usage: withEndpointCost(params, usageFrom(body.usage) ?? UNKNOWN_COST_USAGE),
						...((sanitizeGenerationId(body.id) ?? sanitizeGenerationId(response.headers?.get?.("x-generation-id")))
							? { generationId: sanitizeGenerationId(body.id) ?? sanitizeGenerationId(response.headers.get("x-generation-id")) }
							: {}),
						timing: timer.finish(body.model ?? params.model),
						finishReason: normalizeFinishReason(body.choices?.[0]?.finish_reason),
					};
				} finally {
					attempt.dispose();
				}
			},
			{
				signal: budget.signal,
				onRetry: timer.onRetry,
				...(params.endpoint ? { retryIf: isRetryableProviderError } : {}),
			},
		);
	} finally {
		budget.dispose();
	}
}
