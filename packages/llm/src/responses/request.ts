import { createHash } from "node:crypto";
import { parseModelRef } from "@workspace/shared";
import type { CompleteChatWithToolsParams } from "../chat-tools.js";
import { toResponses } from "./to-responses.js";

/**
 * Chave de cache de prompt da Responses API (plano ChatGPT e OpenCode Go): o mesmo valor em todos os pedidos de
 * uma conversa mantém o roteamento no mesmo cache entre os turnos. Ligada por padrão; `ATLAS_PROMPT_CACHE_KEY=0`
 * (ou off/false/no) desliga sem mexer em código.
 */
export function promptCacheKeyEnabled(env: Record<string, string | undefined> = process.env): boolean {
	const value = env.ATLAS_PROMPT_CACHE_KEY?.trim().toLowerCase();
	return !(value === "0" || value === "off" || value === "false" || value === "no");
}

const SAFE_KEY = /^[A-Za-z0-9_-]{8,64}$/;

/** Derivada do id estável da sessão/conversa: já em formato seguro passa como está; qualquer outro vira hash (sem dado pessoal). */
export function promptCacheKeyFor(sessionId: string | undefined): string | undefined {
	const id = sessionId?.trim();
	if (!id) return undefined;
	return SAFE_KEY.test(id) ? id : `k${createHash("sha256").update(id).digest("hex").slice(0, 31)}`;
}

export function responsesRequestBody(params: CompleteChatWithToolsParams, slugOverride?: string, options: { promptCacheKey?: boolean } = {}) {
	const ref = parseModelRef(params.model);
	if (slugOverride === undefined && ref.provider !== "chatgpt") throw new Error("Responses requires a ChatGPT model reference");
	const cacheKey = options.promptCacheKey !== false && promptCacheKeyEnabled() ? promptCacheKeyFor(params.sessionId) : undefined;
	return {
		model: slugOverride ?? ref.slug,
		...toResponses(params.messages, params.model),
		tools: params.tools.map((tool) => {
			if (tool.type !== "function") throw new Error("Only local function tools are supported");
			return { type: "function", ...tool.function };
		}),
		tool_choice: params.toolChoice ?? "auto",
		stream: true,
		store: false,
		...(cacheKey ? { prompt_cache_key: cacheKey } : {}),
	};
}
