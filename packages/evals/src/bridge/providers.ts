import { createAnthropicStreamChat, createOpencodeGoStreamChat, createProviderStreamChat, streamChatWithTools, ANTHROPIC_API_BASE_URL, type LlmUsage } from "@workspace/llm";
import { parseModelRef } from "@workspace/shared";
import type { StreamChat } from "../mock-model.js";

/**
 * Modelo real da avaliação da ponte. A chave vem do AMBIENTE e nunca é impressa nem gravada:
 * - `OPENROUTER_API_KEY` (a mesma que o `packages/llm` e o worker já usam): qualquer id sem prefixo, ex. `deepseek/...`;
 * - `OPENCODE_GO_API_KEY` (nome só deste CLI: em produção a chave do OpenCode Go vive no cofre do usuário): ids `opencode-go/<slug>`.
 * - `claude-*` (ex.: `claude-haiku-5-5`, ou `anthropic-direct/claude-*`): Anthropic direto, pela Messages API (o adaptador do
 *   `packages/llm`). Chave, na ordem: `ANTHROPIC_API_KEY`, `CLAUDE_KEY`, `claude_key`. A Anthropic não devolve custo, então o
 *   custo por chamada sai dos tokens (tabela `CLAUDE_DIRECT_PRICES`, editável por `--prices`).
 * Plano ChatGPT (OAuth) não tem chave de ambiente: use o slug equivalente no OpenRouter.
 * Em `anthropic/claude-*` (com barra) o id continua sendo o do OpenRouter.
 */

export const OPENROUTER_ENV = "OPENROUTER_API_KEY";
export const OPENCODE_GO_ENV = "OPENCODE_GO_API_KEY";

export const ANTHROPIC_ENV_NAMES = ["ANTHROPIC_API_KEY", "CLAUDE_KEY", "claude_key"] as const;

/** Modelo Claude servido pela Anthropic direta: `claude-*` ou `anthropic-direct/claude-*` (nunca `anthropic/claude-*`, que é OpenRouter). */
export function isClaudeDirect(model: string): boolean {
	return /^(anthropic-direct\/)?claude-[A-Za-z0-9._-]+$/.test(model);
}

const directId = (model: string) => (model.startsWith("anthropic-direct/") ? model : `anthropic-direct/${model}`);

/** Primeira chave Anthropic presente no ambiente, na ordem de `ANTHROPIC_ENV_NAMES`. O valor nunca sai daqui para log. */
export function anthropicKeyFrom(env: Record<string, string | undefined>): string {
	for (const name of ANTHROPIC_ENV_NAMES) {
		const value = env[name]?.trim();
		if (value) return value;
	}
	return "";
}

/** US$ por milhão de tokens. Cache lido e gravado são frações do preço de entrada (convenção da Anthropic: 0,1x e 1,25x). */
export type ClaudePrice = { model: string; promptUsdPerMTok: number; completionUsdPerMTok: number; cacheReadFactor?: number; cacheWriteFactor?: number; longPromptTokens?: number; longMultiplier?: number };

/**
 * Preço de lista da Anthropic (skill claude-api, tabela de 2026-10-06): Haiku 5.5 US$ 0,10 / 0,50 por Mtok até 100 mil tokens de
 * prompt e US$ 0,50 / 2,50 acima. Confira em https://platform.claude.com/docs/en/about-claude/pricing e sobrescreva com `--prices`.
 */
export const CLAUDE_DIRECT_PRICES: readonly ClaudePrice[] = [
	{ model: "claude-haiku-5-5", promptUsdPerMTok: 0.1, completionUsdPerMTok: 0.5, longPromptTokens: 100_000, longMultiplier: 5 },
	{ model: "claude-sonnet-5-5", promptUsdPerMTok: 2, completionUsdPerMTok: 10 },
	{ model: "claude-opus-5-5", promptUsdPerMTok: 4, completionUsdPerMTok: 20 },
];

/** Custo de UMA chamada a partir dos tokens que a Anthropic informou (`promptTokens` = entrada nova + cache lido + cache gravado). */
export function claudeCallCostUsd(usage: Pick<LlmUsage, "promptTokens" | "completionTokens" | "cachedTokens" | "cacheWriteTokens">, price: ClaudePrice): number {
	const prompt = usage.promptTokens ?? 0;
	const read = usage.cachedTokens ?? 0;
	const write = usage.cacheWriteTokens ?? 0;
	const fresh = Math.max(0, prompt - read - write);
	const long = price.longPromptTokens !== undefined && prompt > price.longPromptTokens ? (price.longMultiplier ?? 1) : 1;
	const input = (fresh + read * (price.cacheReadFactor ?? 0.1) + write * (price.cacheWriteFactor ?? 1.25)) * price.promptUsdPerMTok * long;
	return (input + (usage.completionTokens ?? 0) * price.completionUsdPerMTok * long) / 1_000_000;
}

/** Preço de um modelo: `--prices` vence a tabela embutida; modelo sem preço é erro claro (nunca custo 0 silencioso). */
export function claudePriceFor(model: string, prices: readonly ClaudePrice[] = CLAUDE_DIRECT_PRICES): ClaudePrice {
	const id = model.replace(/^anthropic-direct\//, "");
	const found = prices.find((price) => price.model === id) ?? CLAUDE_DIRECT_PRICES.find((price) => price.model === id);
	if (!found) throw new Error(`sem preço para ${id}: informe com --prices <arquivo.json> (promptUsdPerMTok/completionUsdPerMTok por Mtok). Nada foi executado.`);
	return found;
}

export type RealModel = { streamChat: StreamChat; apiKey: string; secrets: string[] };

/** Erro claro (nome da variável, nunca o valor) para o que falta ou não é suportado, ANTES de gastar qualquer token. */
export function assertKeysFor(models: readonly string[], env: Record<string, string | undefined> = process.env, prices: readonly ClaudePrice[] = CLAUDE_DIRECT_PRICES): void {
	for (const model of models) if (isClaudeDirect(model)) claudePriceFor(model, prices);
	const missing = new Set<string>();
	const unsupported: string[] = [];
	for (const model of models) {
		if (isClaudeDirect(model)) {
			if (!anthropicKeyFrom(env)) missing.add(ANTHROPIC_ENV_NAMES.join(" ou "));
			continue;
		}
		const { provider } = parseModelRef(model);
		if (provider === "openrouter" && !env[OPENROUTER_ENV]?.trim()) missing.add(OPENROUTER_ENV);
		else if (provider === "opencode-go" && !env[OPENCODE_GO_ENV]?.trim()) missing.add(OPENCODE_GO_ENV);
		else if (provider === "chatgpt" || provider === "anthropic") unsupported.push(`${model} (${provider === "chatgpt" ? "use o slug do OpenRouter, ex.: openai/gpt-5-mini" : "para Anthropic direta use claude-<modelo>, ex.: claude-haiku-5-5"})`);
	}
	if (unsupported.length > 0) throw new Error(`provedor sem chave de ambiente no eval: ${unsupported.join("; ")}`);
	if (missing.size > 0) throw new Error(`variável de ambiente ausente: ${[...missing].join(", ")} (exporte ou passe --env-file <.env>; o valor nunca é impresso). Nada foi executado.`);
}

export type RealModelOptions = { fetch?: typeof fetch; prices?: readonly ClaudePrice[] };

export function createRealModel(env: Record<string, string | undefined> = process.env, options: RealModelOptions = {}): RealModel {
	const openrouter = env[OPENROUTER_ENV]?.trim() ?? "";
	const opencode = env[OPENCODE_GO_ENV]?.trim() ?? "";
	const anthropic = anthropicKeyFrom(env);
	const anthropicChat = anthropic
		? createAnthropicStreamChat({ provider: "anthropic", getApiKey: async () => anthropic, url: `${ANTHROPIC_API_BASE_URL}/v1/messages`, auth: "x-api-key", ...(options.fetch ? { fetch: options.fetch } : {}) })
		: undefined;
	const router = createProviderStreamChat({
		openrouter: streamChatWithTools,
		chatgpt: () => {
			throw new Error("plano ChatGPT usa OAuth do usuário: no eval use o slug do OpenRouter");
		},
		...(opencode ? { opencodeGo: createOpencodeGoStreamChat({ getApiKey: async () => opencode }) } : {}),
		...(anthropicChat ? { anthropic: anthropicChat } : {}),
	});
	const streamChat: StreamChat = async (params, handlers) => {
		if (!isClaudeDirect(params.model)) return router(params, handlers ?? {});
		if (!anthropicChat) throw new Error(`variável de ambiente ausente: ${ANTHROPIC_ENV_NAMES.join(" ou ")}`);
		// O adaptador deriva o slug do que vem depois da primeira "/": o prefixo direto só existe nesta chamada, o registro guarda o id digitado.
		const result = await router({ ...params, model: directId(params.model) }, handlers ?? {});
		if (!result.usage) return result;
		const { costUnknown: _unknown, ...usage } = result.usage;
		return { ...result, usage: { ...usage, costUsd: claudeCallCostUsd(usage, claudePriceFor(params.model, options.prices)) } };
	};
	return { streamChat, apiKey: openrouter || opencode || anthropic, secrets: [openrouter, opencode, anthropic].filter(Boolean) };
}
