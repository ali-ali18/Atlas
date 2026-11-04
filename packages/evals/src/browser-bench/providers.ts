import { ANTHROPIC_API_BASE_URL, createAnthropicStreamChat, createProviderStreamChat, streamChatWithTools, type LlmUsage } from "@workspace/llm";
import type { StreamChat } from "../mock-model.js";

/**
 * Modelo real do bench do navegador. Mesmo desenho do provedor da avaliação da ponte (marco M1, branch
 * `feat/harness-v3-m1-ponte`, `packages/evals/src/bridge/providers.ts`): `claude-*` vai direto à Anthropic (Messages API
 * pelo adaptador do `packages/llm`) com a chave em ANTHROPIC_API_KEY, CLAUDE_KEY ou claude_key; qualquer outro id vai ao
 * OpenRouter (OPENROUTER_API_KEY). A Anthropic não informa custo: sai dos tokens com o preço de lista (cache lido 0,1x,
 * gravado 1,25x). Quando o M1 entrar no `harness/v3`, trocar este arquivo por um import do dele (ver README).
 * A chave vem do AMBIENTE e nunca é impressa nem gravada.
 */

export const ANTHROPIC_ENV_NAMES = ["ANTHROPIC_API_KEY", "CLAUDE_KEY", "claude_key"] as const;

/** `claude-*` ou `anthropic-direct/claude-*` (nunca `anthropic/claude-*`, que é o id do OpenRouter). */
export const isClaudeDirect = (model: string) => /^(anthropic-direct\/)?claude-[A-Za-z0-9._-]+$/.test(model);
const directId = (model: string) => (model.startsWith("anthropic-direct/") ? model : `anthropic-direct/${model}`);

export function anthropicKeyFrom(env: Record<string, string | undefined>): string {
	for (const name of ANTHROPIC_ENV_NAMES) {
		const value = env[name]?.trim();
		if (value) return value;
	}
	return "";
}

/** US$ por milhão de tokens. */
export type ClaudePrice = { model: string; promptUsdPerMTok: number; completionUsdPerMTok: number; cacheReadFactor?: number; cacheWriteFactor?: number; longPromptTokens?: number; longMultiplier?: number };

/** Preço de lista usado no M1 (confira em https://platform.claude.com/docs/en/about-claude/pricing e sobrescreva com `--prices`). */
export const CLAUDE_DIRECT_PRICES: readonly ClaudePrice[] = [
	{ model: "claude-haiku-5-5", promptUsdPerMTok: 0.1, completionUsdPerMTok: 0.5, longPromptTokens: 100_000, longMultiplier: 5 },
	{ model: "claude-sonnet-5-5", promptUsdPerMTok: 2, completionUsdPerMTok: 10 },
	{ model: "claude-opus-5-5", promptUsdPerMTok: 4, completionUsdPerMTok: 20 },
];

export function claudeCallCostUsd(usage: Pick<LlmUsage, "promptTokens" | "completionTokens" | "cachedTokens" | "cacheWriteTokens">, price: ClaudePrice): number {
	const prompt = usage.promptTokens ?? 0;
	const read = usage.cachedTokens ?? 0;
	const write = usage.cacheWriteTokens ?? 0;
	const fresh = Math.max(0, prompt - read - write);
	const long = price.longPromptTokens !== undefined && prompt > price.longPromptTokens ? (price.longMultiplier ?? 1) : 1;
	const input = (fresh + read * (price.cacheReadFactor ?? 0.1) + write * (price.cacheWriteFactor ?? 1.25)) * price.promptUsdPerMTok * long;
	return (input + (usage.completionTokens ?? 0) * price.completionUsdPerMTok * long) / 1_000_000;
}

/** Modelo sem preço é erro claro (nunca custo 0 silencioso). */
export function claudePriceFor(model: string, prices: readonly ClaudePrice[] = CLAUDE_DIRECT_PRICES): ClaudePrice {
	const id = model.replace(/^anthropic-direct\//, "");
	const found = prices.find((price) => price.model === id) ?? CLAUDE_DIRECT_PRICES.find((price) => price.model === id);
	if (!found) throw new Error(`sem preço para ${id}: informe com --prices <arquivo.json>. Nada foi executado.`);
	return found;
}

/** Erro claro (nome da variável, nunca o valor) ANTES de gastar qualquer token. */
export function assertKeysFor(models: readonly string[], env: Record<string, string | undefined> = process.env, prices: readonly ClaudePrice[] = CLAUDE_DIRECT_PRICES): void {
	const missing = new Set<string>();
	for (const model of models) {
		if (isClaudeDirect(model)) {
			claudePriceFor(model, prices);
			if (!anthropicKeyFrom(env)) missing.add(ANTHROPIC_ENV_NAMES.join(" ou "));
		} else if (!env.OPENROUTER_API_KEY?.trim()) missing.add("OPENROUTER_API_KEY");
	}
	if (missing.size > 0) throw new Error(`variável de ambiente ausente: ${[...missing].join(", ")} (exporte ou passe --env-file <.env>; o valor nunca é impresso). Nada foi executado.`);
}

export type RealModel = { streamChat: StreamChat; secrets: string[] };

export function createRealModel(env: Record<string, string | undefined> = process.env, options: { fetch?: typeof fetch; prices?: readonly ClaudePrice[] } = {}): RealModel {
	const openrouter = env.OPENROUTER_API_KEY?.trim() ?? "";
	const anthropic = anthropicKeyFrom(env);
	const anthropicChat = anthropic ? createAnthropicStreamChat({ provider: "anthropic", getApiKey: async () => anthropic, url: `${ANTHROPIC_API_BASE_URL}/v1/messages`, auth: "x-api-key", ...(options.fetch ? { fetch: options.fetch } : {}) }) : undefined;
	const router = createProviderStreamChat({
		openrouter: streamChatWithTools,
		chatgpt: () => {
			throw new Error("plano ChatGPT usa OAuth do usuário: no bench use o slug do OpenRouter");
		},
		...(anthropicChat ? { anthropic: anthropicChat } : {}),
	});
	const streamChat: StreamChat = async (params, handlers) => {
		if (!isClaudeDirect(params.model)) return router(params, handlers ?? {});
		if (!anthropicChat) throw new Error(`variável de ambiente ausente: ${ANTHROPIC_ENV_NAMES.join(" ou ")}`);
		const result = await router({ ...params, model: directId(params.model) }, handlers ?? {});
		if (!result.usage) return result;
		const { costUnknown: _unknown, ...usage } = result.usage;
		return { ...result, usage: { ...usage, costUsd: claudeCallCostUsd(usage, claudePriceFor(params.model, options.prices)) } };
	};
	return { streamChat, secrets: [openrouter, anthropic].filter(Boolean) };
}
