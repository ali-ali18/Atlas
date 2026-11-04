import { CLAUDE_DIRECT_PRICES } from "../../bridge/providers.js";
import { PRICE_ASSUMPTIONS, type ModelPrice } from "../../bridge/cost.js";
import type { RunMetrics } from "./metrics.js";
import { V3_ENGINES, type V3Engine } from "./types.js";

/**
 * Estimativa de custo da rodada real ANTES de gastar (`--estimate`). Os tokens por motor vêm de uma rodada mock (os mesmos
 * prompts, tools e fixtures de cada motor), então o prompt é medido; a saída, o raciocínio e os passos extras de um modelo de
 * verdade são suposição: margem de 2x (a avaliação tem tarefas abertas, como o navegador do T2 e a pesquisa do T8, em que um
 * modelo real dá bem mais passos que o roteiro) e `extraOutputPerStep` de raciocínio. O repositório não tem tabela de preços
 * por modelo: os `claude-*` usam o preço de lista de `CLAUDE_DIRECT_PRICES` (confira e sobrescreva com `--prices`).
 */

export const V3_ESTIMATE_MARGIN = 2;
/** Raciocínio adaptativo dos claude-* (tokens de saída além do roteiro, por passo). */
export const CLAUDE_EXTRA_OUTPUT_PER_STEP = 300;
/** Cache lido custa 0,1x o preço de entrada (convenção da Anthropic). */
const CACHE_READ_FACTOR = 0.1;

export type EngineTokens = { runs: number; steps: number; promptTokens: number; cachedTokens: number; completionTokens: number };

/** Tokens por motor de UMA repetição da bateria (a partir da rodada mock). */
export function tokensPerEngine(runs: readonly RunMetrics[]): Record<V3Engine, EngineTokens> {
	const out = Object.fromEntries(V3_ENGINES.map((engine) => [engine, { runs: 0, steps: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0 }])) as Record<V3Engine, EngineTokens>;
	for (const run of runs) {
		const bucket = out[run.engine];
		bucket.runs += 1;
		bucket.steps += run.modelCalls;
		bucket.promptTokens += run.promptTokens;
		bucket.cachedTokens += run.cachedTokens;
		bucket.completionTokens += run.completionTokens;
	}
	return out;
}

export type ModelEstimate = { price: ModelPrice; floorUsd: number; expectedUsd: number; expectedWithCacheUsd: number };

/** Custo de UM modelo para `repeat` repetições nos motores dados: piso (roteiro puro), esperado (margem e raciocínio) e esperado com o cache simulado. */
export function estimateModel(price: ModelPrice, tokens: Record<V3Engine, EngineTokens>, input: { engines: readonly V3Engine[]; repeat: number; margin?: number }): ModelEstimate {
	const margin = input.margin ?? V3_ESTIMATE_MARGIN;
	let floor = 0;
	let expected = 0;
	let expectedWithCache = 0;
	for (const engine of input.engines) {
		const bucket = tokens[engine];
		const completion = bucket.completionTokens + bucket.steps * price.extraOutputPerStep;
		const out = (completion * price.completionUsdPerMTok) / 1_000_000;
		floor += (bucket.promptTokens * price.promptUsdPerMTok + bucket.completionTokens * price.completionUsdPerMTok) / 1_000_000;
		expected += (bucket.promptTokens * price.promptUsdPerMTok) / 1_000_000 + out;
		const fresh = Math.max(0, bucket.promptTokens - bucket.cachedTokens);
		expectedWithCache += ((fresh + bucket.cachedTokens * CACHE_READ_FACTOR) * price.promptUsdPerMTok) / 1_000_000 + out;
	}
	return { price, floorUsd: floor * input.repeat, expectedUsd: expected * input.repeat * margin, expectedWithCacheUsd: expectedWithCache * input.repeat * margin };
}

/** Preço de planejamento de um modelo: `claude-*` direto (tabela da Anthropic) ou a lista de suposições do OpenRouter. */
export function planningPrice(model: string, extra: readonly ModelPrice[] = []): ModelPrice {
	const known = [...extra, ...PRICE_ASSUMPTIONS].find((item) => item.model === model);
	if (known) return known;
	const id = model.replace(/^anthropic-direct\//, "");
	const direct = CLAUDE_DIRECT_PRICES.find((item) => item.model === id);
	if (direct) return { model, label: `${id} (Anthropic direta)`, promptUsdPerMTok: direct.promptUsdPerMTok, completionUsdPerMTok: direct.completionUsdPerMTok, extraOutputPerStep: CLAUDE_EXTRA_OUTPUT_PER_STEP, strong: /sonnet|opus|fable/i.test(id) };
	throw new Error(`sem preço para ${model} na estimativa: informe com --prices <arquivo.json>. Nada foi executado.`);
}

const usd = (value: number) => `US$ ${value.toFixed(2)}`;

/** Markdown da estimativa (pt-BR). */
export function formatV3Estimate(tokens: Record<V3Engine, EngineTokens>, options: { models: readonly ModelPrice[]; engines: readonly V3Engine[]; repeat: number; tasks: number }): string {
	const lines: string[] = [];
	lines.push("## Estimativa de custo da rodada real", "");
	lines.push(`Tokens de UMA repetição (${options.tasks} tarefas), medidos na rodada mock com o cache de prefixo simulado: v2 ${tokens.v2.promptTokens.toLocaleString("pt-BR")} de entrada (${tokens.v2.cachedTokens.toLocaleString("pt-BR")} em cache) em ${tokens.v2.steps} chamadas; v3 ${tokens.v3.promptTokens.toLocaleString("pt-BR")} de entrada (${tokens.v3.cachedTokens.toLocaleString("pt-BR")} em cache) em ${tokens.v3.steps} chamadas.`);
	lines.push(`Motores: ${options.engines.join(" + ")} · ${options.repeat} repetição(ões). **Esperado** = margem de ${V3_ESTIMATE_MARGIN}x sobre o roteiro (um modelo real dá mais passos que o roteiro, principalmente em T2, T7, T8 e T12) mais ${CLAUDE_EXTRA_OUTPUT_PER_STEP} tokens de raciocínio por passo nos claude-*; **piso** = só o roteiro, sem margem nem raciocínio; "com cache" aplica o desconto de leitura de cache (0,1x) que o mock simulou.`, "");
	lines.push("| Modelo | Preço US$/Mtok (entrada / saída) | Piso (roteiro) | Esperado, sem desconto de cache | Esperado, com cache simulado |", "|---|---|---|---|---|");
	let floor = 0;
	let expected = 0;
	let withCache = 0;
	for (const price of options.models) {
		const estimate = estimateModel(price, tokens, { engines: options.engines, repeat: options.repeat });
		floor += estimate.floorUsd;
		expected += estimate.expectedUsd;
		withCache += estimate.expectedWithCacheUsd;
		lines.push(`| ${price.label} (\`${price.model}\`) | ${price.promptUsdPerMTok} / ${price.completionUsdPerMTok} | ${usd(estimate.floorUsd)} | ${usd(estimate.expectedUsd)} | ${usd(estimate.expectedWithCacheUsd)} |`);
	}
	lines.push(`| **Total** | | ${usd(floor)} | ${usd(expected)} | ${usd(withCache)} |`, "");
	lines.push(`Sugestão de teto: \`--max-cost ${Math.max(1, Math.ceil(expected * 1.25))}\` (esperado sem desconto de cache + 25% de folga). O teto só impede INICIAR novas execuções depois de atingido; as em andamento terminam. O juiz offline (\`--judge\`) soma uma chamada curta por run e não entra nesta conta.`);
	lines.push("Preços de lista (Anthropic direta, tabela de 2026-10-06 da skill claude-api); confira em https://platform.claude.com/docs/en/about-claude/pricing e sobrescreva com `--prices`. Outros modelos usam as suposições de planejamento do pacote (não verificadas).");
	return lines.join("\n");
}
