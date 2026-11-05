import type { Prices } from "../engine-compare/metrics.js";

/**
 * Tabela de preços do `matrix` (US$ por milhão de tokens). O repositório não tinha tabela por modelo (o motor v2 só
 * usa um preço de reserva de classe Sonnet), então ela mora aqui, só para o eval. Preço desconhecido nunca vira 0:
 * cai no padrão conservador e marca `costUnknown` na execução e no relatório.
 *
 * Chave: `<provedor>/<slug>` (provedor = anthropic | opencode-go | openrouter). OpenRouter informa o custo real em
 * `usage.cost`; só entra aqui se faltar.
 */

export type PriceEntry = Prices & {
	/** Fração do preço de entrada que um token lido do cache custa. */
	cachedRatio: number;
	/** Múltiplo do preço de entrada para token gravado no cache. */
	writeRatio: number;
	source: string;
	/** false = valor a confirmar com a tabela oficial antes de confiar no número. */
	confirmed: boolean;
};

const GO_SOURCE = "opencode.ai/docs/go (valores do dono em 05/11)";
const ANTHROPIC_SOURCE = "tabela de modelos da Anthropic (API direta, cache 2026-10-06; haiku 5.5 vale até 100K tokens de entrada, acima disso 0,50/2,50)";

export const PRICE_TABLE: Record<string, PriceEntry> = {
	// OpenCode Go. deepseek-v4.1-flash: 0,30/1,20 é o preço de pico (conservador).
	"opencode-go/deepseek-v4.1-flash": { promptUsdPerMTok: 0.3, completionUsdPerMTok: 1.2, cachedRatio: 0.1, writeRatio: 1, source: GO_SOURCE, confirmed: true },
	"opencode-go/qwen3.8-flash": { promptUsdPerMTok: 0.15, completionUsdPerMTok: 0.47, cachedRatio: 0.1, writeRatio: 1, source: GO_SOURCE, confirmed: true },
	"opencode-go/claude-haiku-5-5": { promptUsdPerMTok: 0.1, completionUsdPerMTok: 0.5, cachedRatio: 0.1, writeRatio: 1, source: GO_SOURCE, confirmed: true },
	// Anthropic direto (gravação de cache 1,25x). Leitura de cache: sonnet e opus 5.5 a US$ 0,20 (0,1x e 0,05x).
	"anthropic/claude-haiku-5-5": { promptUsdPerMTok: 0.1, completionUsdPerMTok: 0.5, cachedRatio: 0.1, writeRatio: 1.25, source: ANTHROPIC_SOURCE, confirmed: true },
	"anthropic/claude-sonnet-5-5": { promptUsdPerMTok: 2, completionUsdPerMTok: 10, cachedRatio: 0.1, writeRatio: 1.25, source: ANTHROPIC_SOURCE, confirmed: true },
	"anthropic/claude-opus-5-5": { promptUsdPerMTok: 4, completionUsdPerMTok: 20, cachedRatio: 0.05, writeRatio: 1.25, source: ANTHROPIC_SOURCE, confirmed: true },
};

/** Preço de reserva (classe Sonnet, igual ao do motor v2) quando o modelo não está na tabela. Sem desconto de cache. */
export const UNKNOWN_PRICE: PriceEntry = { promptUsdPerMTok: 3, completionUsdPerMTok: 15, cachedRatio: 1, writeRatio: 1, source: "padrão conservador (modelo fora da tabela)", confirmed: false };

export function priceFor(key: string, table: Record<string, PriceEntry> = PRICE_TABLE): { price: PriceEntry; known: boolean } {
	const entry = table[key];
	return entry ? { price: entry, known: true } : { price: UNKNOWN_PRICE, known: false };
}

export type TokenUsage = { promptTokens?: number; completionTokens?: number; cachedTokens?: number; cacheWriteTokens?: number };

/** `promptTokens` já inclui cache lido e gravado (convenção do adaptador). */
export function costFromTokens(usage: TokenUsage, price: PriceEntry): number {
	const prompt = Math.max(0, usage.promptTokens ?? 0);
	const cached = Math.min(Math.max(0, usage.cachedTokens ?? 0), prompt);
	const written = Math.min(Math.max(0, usage.cacheWriteTokens ?? 0), prompt - cached);
	const fresh = prompt - cached - written;
	const promptEquivalent = fresh + cached * price.cachedRatio + written * price.writeRatio;
	return (promptEquivalent * price.promptUsdPerMTok + Math.max(0, usage.completionTokens ?? 0) * price.completionUsdPerMTok) / 1_000_000;
}
