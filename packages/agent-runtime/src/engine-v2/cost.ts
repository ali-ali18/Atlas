/**
 * Motor v2: custo para o orçamento em US$. O provedor às vezes não informa o custo (`costUnknownCalls`); contar
 * isso como zero deixaria o teto sem efeito. Sem tabela de preços por modelo no repositório, a chamada sem custo é
 * estimada pelos tokens com um preço CONSERVADOR (classe Sonnet), configurável por ambiente. Puro.
 */
export type TokenPrices = { promptUsdPerMTok: number; completionUsdPerMTok: number };

export const DEFAULT_FALLBACK_PRICES: TokenPrices = { promptUsdPerMTok: 3, completionUsdPerMTok: 15 };

export function fallbackPricesFromEnv(env: Record<string, string | undefined> = process.env): TokenPrices {
	const read = (value: string | undefined, fallback: number) => {
		const parsed = Number(value);
		return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
	};
	return {
		promptUsdPerMTok: read(env.ATLAS_V2_FALLBACK_PROMPT_USD_PER_MTOK, DEFAULT_FALLBACK_PRICES.promptUsdPerMTok),
		completionUsdPerMTok: read(env.ATLAS_V2_FALLBACK_COMPLETION_USD_PER_MTOK, DEFAULT_FALLBACK_PRICES.completionUsdPerMTok),
	};
}

export function estimateCostUsd(tokens: { promptTokens: number; completionTokens: number }, prices: TokenPrices = DEFAULT_FALLBACK_PRICES): number {
	return (tokens.promptTokens * prices.promptUsdPerMTok + tokens.completionTokens * prices.completionUsdPerMTok) / 1_000_000;
}

/** Custo de UMA chamada: o informado, ou a estimativa quando o provedor não informou (e não é cota de plano). */
export function callCostUsd(usage: { costUsd?: number; costUnknownCalls?: number; promptTokens: number; completionTokens: number }, prices?: TokenPrices): { costUsd: number; estimated: boolean } {
	if (usage.costUsd !== undefined) return { costUsd: usage.costUsd, estimated: false };
	if ((usage.costUnknownCalls ?? 0) > 0) return { costUsd: estimateCostUsd(usage, prices), estimated: true };
	return { costUsd: 0, estimated: false };
}
