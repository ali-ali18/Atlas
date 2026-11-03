/**
 * Motor v2: custo para o orçamento em US$. O provedor às vezes não informa o custo (`costUnknownCalls`); contar
 * isso como zero deixaria o teto sem efeito. Sem tabela de preços por modelo no repositório, a chamada sem custo é
 * estimada pelos tokens com um preço CONSERVADOR (classe Sonnet), configurável por ambiente. Puro.
 */
export type TokenPrices = { promptUsdPerMTok: number; completionUsdPerMTok: number; /** Fração do preço de entrada que um token em cache custa (0..1). */ cachedPromptRatio?: number };

/**
 * Token de entrada em cache custa uma fração do normal (Anthropic ~0,1; OpenAI/Gemini 0,25 a 0,5). 0,25 é conservador o bastante
 * para o teto não ficar frouxo e não cobra o prompt inteiro de um run cujo prefixo é quase todo cache.
 */
export const DEFAULT_CACHED_PROMPT_RATIO = 0.25;

export const DEFAULT_FALLBACK_PRICES: TokenPrices = { promptUsdPerMTok: 3, completionUsdPerMTok: 15, cachedPromptRatio: DEFAULT_CACHED_PROMPT_RATIO };

export function fallbackPricesFromEnv(env: Record<string, string | undefined> = process.env): TokenPrices {
	const read = (value: string | undefined, fallback: number) => {
		const parsed = Number(value);
		return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
	};
	return {
		promptUsdPerMTok: read(env.ATLAS_V2_FALLBACK_PROMPT_USD_PER_MTOK, DEFAULT_FALLBACK_PRICES.promptUsdPerMTok),
		completionUsdPerMTok: read(env.ATLAS_V2_FALLBACK_COMPLETION_USD_PER_MTOK, DEFAULT_FALLBACK_PRICES.completionUsdPerMTok),
		cachedPromptRatio: Math.min(1, read(env.ATLAS_V2_FALLBACK_CACHED_PROMPT_RATIO, DEFAULT_CACHED_PROMPT_RATIO)),
	};
}

export function estimateCostUsd(tokens: { promptTokens: number; completionTokens: number; cachedTokens?: number }, prices: TokenPrices = DEFAULT_FALLBACK_PRICES): number {
	// `cachedTokens` é parte de `promptTokens`: o que veio do cache custa só uma fração (sem isso um prompt grande e quase todo em cache
	// estourava o teto de US$ muito antes do gasto real).
	const cached = Math.min(Math.max(0, tokens.cachedTokens ?? 0), tokens.promptTokens);
	const ratio = prices.cachedPromptRatio ?? DEFAULT_CACHED_PROMPT_RATIO;
	const promptEquivalent = tokens.promptTokens - cached + cached * ratio;
	return (promptEquivalent * prices.promptUsdPerMTok + tokens.completionTokens * prices.completionUsdPerMTok) / 1_000_000;
}

/** Custo de UMA chamada: o informado, ou a estimativa quando o provedor não informou (e não é cota de plano). */
export function callCostUsd(usage: { costUsd?: number; costUnknownCalls?: number; promptTokens: number; completionTokens: number; cachedTokens?: number }, prices?: TokenPrices): { costUsd: number; estimated: boolean } {
	if (usage.costUsd !== undefined) return { costUsd: usage.costUsd, estimated: false };
	if ((usage.costUnknownCalls ?? 0) > 0) return { costUsd: estimateCostUsd(usage, prices), estimated: true };
	return { costUsd: 0, estimated: false };
}
