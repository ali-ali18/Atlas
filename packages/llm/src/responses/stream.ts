import { formatModelRef, parseModelRef } from "@workspace/shared";
import type { CompleteChatWithToolsParams, CompleteChatWithToolsResult, LlmToolCall, StreamChatWithToolsHandlers } from "../chat-tools.js";
import { abortable, createDecisionBudget } from "../decision-budget.js";
import { withLlmStepRetry } from "../config.js";
import { createCallTimer } from "../timing.js";
import { ChatgptProviderError, chatgptErrorFrom, isRetryableChatgptError } from "./errors.js";
import { responsesRequestBody } from "./request.js";
import { readResponsesSse } from "./sse.js";
import { responseUsage } from "./usage.js";

export type ChatgptTokenOptions = { force?: boolean; previousAccessToken?: string };
export type ChatgptStreamOptions = {
	getAccessToken: (options?: ChatgptTokenOptions) => Promise<string>;
	fetch?: typeof fetch;
	markNeedsLogin?: () => Promise<void>;
	/** Conta ChatGPT do login por código: presente = chamadas vão ao backend do plano (chatgpt.com/backend-api/codex). */
	getAccountId?: () => Promise<string | null>;
	/**
	 * Destino alternativo da Responses API (OpenCode Go): URL completa, id do modelo no
	 * provedor e cabeçalhos extras. O token vira Bearer e o histórico opaco do ChatGPT não é gravado.
	 */
	endpoint?: { url: string; slug: (model: string) => string; headers?: (params: CompleteChatWithToolsParams) => Record<string, string> };
};

export const CHATGPT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
/** Cabeçalhos do backend do plano ChatGPT (mesmos do Codex CLI). */
export function chatgptCodexHeaders(token: string, accountId: string): Record<string, string> {
	return { Authorization: `Bearer ${token}`, "ChatGPT-Account-ID": accountId, originator: "codex_cli_rs", "OpenAI-Beta": "responses=experimental" };
}

/** Destinos da Responses que devolveram 400 por `prompt_cache_key`: depois disso o pedido vai sem a chave. */
const keyRejected = new Set<string>();

/** Só recebe o token SIWC pelo cofre injetado; nenhum token entra no contrato do loop. */
export function createChatgptStreamChat(options: ChatgptStreamOptions) {
	return async (params: CompleteChatWithToolsParams, handlers: StreamChatWithToolsHandlers = {}): Promise<CompleteChatWithToolsResult> => {
		const slug = options.endpoint?.slug(params.model);
		const rejectKey = options.endpoint ? options.endpoint.url : "chatgpt";
		// Destino que recusou `prompt_cache_key` antes: segue sem a chave (a economia de cache vale menos que o pedido).
		let body = responsesRequestBody(params, slug, { promptCacheKey: !keyRejected.has(rejectKey) });
		const timer = createCallTimer(params.model, params.clock);
		const budget = createDecisionBudget(params);
		let delivered = false;
		let refreshed = false;
		const fetchFn = options.fetch ?? fetch;
		const needsLogin = async () => {
			if (options.markNeedsLogin) await abortable(options.markNeedsLogin(), budget.signal);
		};
		try {
			return await withLlmStepRetry(async () => {
				const attempt = budget.attempt();
				try {
					let token = await abortable(options.getAccessToken(), attempt.signal);
					const accountId = options.getAccountId ? await abortable(options.getAccountId(), attempt.signal) : null;
					const send = () => abortable(fetchFn(options.endpoint ? options.endpoint.url : accountId ? `${CHATGPT_CODEX_BASE_URL}/responses` : "https://api.openai.com/v1/responses", {
						method: "POST", headers: { ...(accountId ? chatgptCodexHeaders(token, accountId) : { Authorization: `Bearer ${token}` }), "Content-Type": "application/json", Accept: "text/event-stream", ...(options.endpoint?.headers?.(params) ?? {}) },
						// O backend do plano exige `instructions` não vazio.
						body: JSON.stringify(accountId && !body.instructions ? { ...body, instructions: "Você é um assistente prestativo." } : body), redirect: "error", signal: attempt.signal,
					}), attempt.signal);
					let response = await send();
					if (response.status === 400 && "prompt_cache_key" in body) {
						const detail = await abortable(response.clone().text(), attempt.signal).catch(() => "");
						if (/prompt_cache_key/i.test(detail)) {
							keyRejected.add(rejectKey);
							body = responsesRequestBody(params, slug, { promptCacheKey: false });
							response = await send();
						}
					}
					if (!response.ok) {
						const error = await readError(response, attempt.signal);
						if (error.code === "subscription_sharing_invalid_user") throw error;
						if (response.status !== 401) throw error;
						if (refreshed) { await needsLogin(); throw new ChatgptProviderError(401, "needs_login"); }
						refreshed = true;
						// O cofre compara o token anterior após o lock para evitar duas rotações.
						token = await abortable(options.getAccessToken({ force: true, previousAccessToken: token }), attempt.signal);
						response = await send();
						if (!response.ok) {
							if (response.status === 401) { await needsLogin(); throw new ChatgptProviderError(401, "needs_login"); }
							throw await readError(response, attempt.signal);
						}
					}
					if (!response.body) throw new ChatgptProviderError(502, "stream_interrupted");
					const result = await readResponsesSse(response.body, {
						onUseful: () => { attempt.markUseful(); timer.markFirstChunk(); },
						onDelta: (text) => { if (text) delivered = true; handlers.onDelta?.(text); },
					}, attempt.signal);
					const calls: LlmToolCall[] = result.output.filter((item) => result.finishReason === "stop" && item.type === "function_call").map((item) => {
						if (typeof item.call_id !== "string" || !item.call_id || typeof item.name !== "string" || !item.name || (item.arguments !== undefined && typeof item.arguments !== "string"))
							throw new ChatgptProviderError(502, "invalid_stream");
						return { id: item.call_id, type: "function", function: { name: item.name, arguments: typeof item.arguments === "string" && item.arguments ? item.arguments : "{}" } };
					});
					if (new Set(calls.map((call) => call.id)).size !== calls.length) throw new ChatgptProviderError(502, "invalid_stream");
					const requestedSlug = parseModelRef(params.model).slug;
					// Modelo servido pode ser um slug mais específico; nunca ecoar texto livre.
					let model = params.model;
					if (!options.endpoint) try { model = formatModelRef("chatgpt", result.model ?? requestedSlug); } catch { /* Mantém a referência validada. */ }
					return {
						message: { role: "assistant", content: result.text || null, ...(calls.length ? { tool_calls: calls } : {}), ...(options.endpoint ? {} : { providerItems: { provider: "chatgpt" as const, model: params.model, items: result.output } }) },
						model, usage: responseUsage(result.usage), finishReason: result.finishReason, appliedOutputCap: false, timing: timer.finish(model),
					};
				} catch (error) {
					attempt.signal.throwIfAborted();
					if (error instanceof ChatgptProviderError) {
						if (error.code === "subscription_sharing_invalid_user") await needsLogin();
						throw error;
					}
					if (error !== null && typeof error === "object" && "status" in error && typeof error.status === "number" && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599)
						throw chatgptErrorFrom(error, error.status);
					throw new ChatgptProviderError(502, "network_error");
				} finally { attempt.dispose(); }
			}, { signal: budget.signal, retryIf: (error) => !delivered && isRetryableChatgptError(error), onRetry: (error) => timer.onRetry(error) });
		} finally { budget.dispose(); }
	};
}

async function readError(response: Response, signal: AbortSignal) {
	let payload: unknown;
	try { payload = await abortable(response.json(), signal); }
	catch { signal.throwIfAborted(); }
	return chatgptErrorFrom(payload, response.status);
}
