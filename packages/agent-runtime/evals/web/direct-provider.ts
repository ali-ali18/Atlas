import { ANTHROPIC_API_BASE_URL, createAnthropicStreamChat } from "@workspace/llm";
import type { CompleteChatWithToolsParams, CompleteChatWithToolsResult, StreamChatWithToolsHandlers } from "@workspace/llm";

// Anthropic direto no browser-bench: o harness `eval:web` só falava com o OpenRouter. Aqui o modelo `anthropic-direct/<slug>`
// usa o mesmo adaptador do runtime (createAnthropicStreamChat) com a chave do ambiente. O adaptador só devolve tokens, então o
// custo sai desta tabela (US$/M; mesma da matriz `packages/evals`: Haiku 5.5 0,10/0,50, acima de 100 mil tokens 0,50/2,50).
export type DirectPrice = { in: number; out: number; cachedRatio: number; writeRatio: number; long?: { above: number; in: number; out: number } };

export const DIRECT_PRICES: Record<string, DirectPrice> = {
	"claude-haiku-5-5": { in: 0.1, out: 0.5, cachedRatio: 0.1, writeRatio: 1.25, long: { above: 100_000, in: 0.5, out: 2.5 } },
	"claude-sonnet-5-5": { in: 2, out: 10, cachedRatio: 0.1, writeRatio: 1.25 },
};
/** Modelo fora da tabela: preço de reserva classe Sonnet, sem desconto de cache (nunca 0). */
const FALLBACK: DirectPrice = { in: 3, out: 15, cachedRatio: 1, writeRatio: 1 };

export const DIRECT_PREFIX = "anthropic-direct/";

export function directCostUsd(slug: string, usage: { promptTokens?: number; completionTokens?: number; cachedTokens?: number; cacheWriteTokens?: number }): number {
	const price = DIRECT_PRICES[slug] ?? FALLBACK;
	const prompt = Math.max(0, usage.promptTokens ?? 0);
	const cached = Math.min(Math.max(0, usage.cachedTokens ?? 0), prompt);
	const written = Math.min(Math.max(0, usage.cacheWriteTokens ?? 0), prompt - cached);
	const equivalent = prompt - cached - written + cached * price.cachedRatio + written * price.writeRatio;
	const rate = price.long && prompt > price.long.above ? price.long : price;
	return (equivalent * rate.in + Math.max(0, usage.completionTokens ?? 0) * rate.out) / 1_000_000;
}

export function directApiKey(env: NodeJS.ProcessEnv = process.env): string {
	return env.CLAUDE_KEY?.trim() || env.ANTHROPIC_API_KEY?.trim() || "";
}

/** streamChat com custo calculado; a chave só vive no fechamento. */
export function createDirectStreamChat(getKey: () => string, options: { fetch?: typeof fetch } = {}) {
	const inner = createAnthropicStreamChat({
		provider: "anthropic",
		getApiKey: async () => {
			const key = getKey();
			if (!key) throw new Error("chave da Anthropic ausente (CLAUDE_KEY ou ANTHROPIC_API_KEY)");
			return key;
		},
		url: `${ANTHROPIC_API_BASE_URL}/v1/messages`,
		auth: "x-api-key",
		...(options.fetch ? { fetch: options.fetch } : {}),
	});
	return async (params: CompleteChatWithToolsParams, handlers?: StreamChatWithToolsHandlers): Promise<CompleteChatWithToolsResult> => {
		const result = await inner(params, handlers);
		const slug = params.model.slice(DIRECT_PREFIX.length);
		const { costUnknown: _unknown, costKind: _kind, ...usage } = result.usage ?? {};
		return { ...result, usage: { ...usage, costUsd: directCostUsd(slug, usage) } };
	};
}
