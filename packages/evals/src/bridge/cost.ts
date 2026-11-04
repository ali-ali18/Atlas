import type { BridgeEngine, BridgeRunMetrics } from "./metrics.js";

/**
 * Estimativa de custo da avaliação da ponte ANTES de gastar (`--estimate`). O repositório NÃO tem tabela de preços por
 * modelo: o OpenRouter devolve o custo real de cada chamada (`usage.cost`) e o `--max-cost` usa esse valor. Os preços
 * abaixo são suposições de planejamento (lista pública aproximada, NÃO verificadas em nov/2026): confira no OpenRouter
 * e sobrescreva com `--prices <arquivo.json>`. Os tokens por tarefa vêm de uma rodada mock (a mesma bateria, os mesmos
 * prompts de cada motor), então o prompt é medido; a saída e o raciocínio dos modelos reais são suposição.
 */

export type ModelPrice = {
	model: string;
	label: string;
	/** US$ por milhão de tokens. */
	promptUsdPerMTok: number;
	completionUsdPerMTok: number;
	/** Tokens de raciocínio/saída além do roteiro, por passo de modelo (modelos "thinking" cobram como saída). */
	extraOutputPerStep: number;
	/** Modelo de controle (forte): não conta nos 2 reprovados de famílias baratas. */
	strong?: boolean;
};

export const PRICE_ASSUMPTIONS: readonly ModelPrice[] = [
	{ model: "deepseek/deepseek-chat", label: "DeepSeek V3.x", promptUsdPerMTok: 0.3, completionUsdPerMTok: 1.1, extraOutputPerStep: 150 },
	{ model: "moonshotai/kimi-k2", label: "Kimi K2", promptUsdPerMTok: 0.6, completionUsdPerMTok: 2.5, extraOutputPerStep: 150 },
	{ model: "qwen/qwen3-coder", label: "Qwen3", promptUsdPerMTok: 0.3, completionUsdPerMTok: 1.2, extraOutputPerStep: 150 },
	{ model: "openai/gpt-5-mini", label: "GPT mini", promptUsdPerMTok: 0.25, completionUsdPerMTok: 2, extraOutputPerStep: 400 },
	{ model: "google/gemini-2.5-flash", label: "Gemini Flash", promptUsdPerMTok: 0.3, completionUsdPerMTok: 2.5, extraOutputPerStep: 400 },
	{ model: "anthropic/claude-sonnet-4.5", label: "Claude Sonnet (controle)", promptUsdPerMTok: 3, completionUsdPerMTok: 15, extraOutputPerStep: 0, strong: true },
];

/** Margem sobre a rodada mock: modelos reais gastam passos extras (busca, nova tentativa de JSON) que o roteiro não tem. */
export const ESTIMATE_MARGIN = 1.3;

export type EngineTokens = { runs: number; steps: number; promptTokens: number; completionTokens: number };

/** Tokens por motor de UMA repetição da bateria (a partir da rodada mock). */
export function tokensPerEngine(runs: readonly BridgeRunMetrics[]): Record<BridgeEngine, EngineTokens> {
	const out: Record<BridgeEngine, EngineTokens> = { v2: { runs: 0, steps: 0, promptTokens: 0, completionTokens: 0 }, v3: { runs: 0, steps: 0, promptTokens: 0, completionTokens: 0 } };
	for (const run of runs) {
		const bucket = out[run.engine];
		bucket.runs += 1;
		bucket.steps += run.modelCalls;
		bucket.promptTokens += run.promptTokens;
		bucket.completionTokens += run.completionTokens;
	}
	return out;
}

/** Custo estimado de UM modelo, em US$, para `repeat` repetições nos motores dados. */
export function estimateModelCost(price: ModelPrice, tokens: Record<BridgeEngine, EngineTokens>, input: { engines: readonly BridgeEngine[]; repeat: number; margin?: number }): number {
	const margin = input.margin ?? ESTIMATE_MARGIN;
	let usd = 0;
	for (const engine of input.engines) {
		const bucket = tokens[engine];
		const completion = bucket.completionTokens + bucket.steps * price.extraOutputPerStep;
		usd += (bucket.promptTokens * price.promptUsdPerMTok + completion * price.completionUsdPerMTok) / 1_000_000;
	}
	return usd * input.repeat * margin;
}

export type EstimateRow = { price: ModelPrice; repeat3Both: number; repeat5Both: number; repeat3V3: number; repeat5V3: number };

export function estimateTable(tokens: Record<BridgeEngine, EngineTokens>, prices: readonly ModelPrice[] = PRICE_ASSUMPTIONS): EstimateRow[] {
	const both: BridgeEngine[] = ["v2", "v3"];
	const v3: BridgeEngine[] = ["v3"];
	return prices.map((price) => ({
		price,
		repeat3Both: estimateModelCost(price, tokens, { engines: both, repeat: 3 }),
		repeat5Both: estimateModelCost(price, tokens, { engines: both, repeat: 5 }),
		repeat3V3: estimateModelCost(price, tokens, { engines: v3, repeat: 3 }),
		repeat5V3: estimateModelCost(price, tokens, { engines: v3, repeat: 5 }),
	}));
}

const PLAN_HEADROOM = 0.9;

export type Plan = { label: string; budgetUsd: number; totalUsd: number; items: Array<{ model: string; engines: BridgeEngine[]; repeat: number; usd: number }> };

/**
 * Configuração que cabe no orçamento: os modelos baratos com o maior `repeat` (até 5) nos dois motores; o controle
 * forte entra com o maior `repeat` que sobra (mínimo 1) e, se nem 1 repetição nos dois motores cabe, só no v3.
 */
export function recommendPlan(tokens: Record<BridgeEngine, EngineTokens>, limitUsd: number, prices: readonly ModelPrice[] = PRICE_ASSUMPTIONS): Plan {
	// 10% de folga: o planejamento é estimativa; o teto de verdade é o `--max-cost`.
	const budgetUsd = limitUsd * PLAN_HEADROOM;
	const both: BridgeEngine[] = ["v2", "v3"];
	const cheap = prices.filter((price) => !price.strong);
	const strong = prices.filter((price) => price.strong);
	const cost = (list: readonly ModelPrice[], repeat: number, engines: BridgeEngine[]) => list.reduce((sum, price) => sum + estimateModelCost(price, tokens, { engines, repeat }), 0);
	let cheapRepeat = 5;
	while (cheapRepeat > 1 && cost(cheap, cheapRepeat, both) > budgetUsd) cheapRepeat -= 1;
	let items: Plan["items"] = cheap.map((price) => ({ model: price.model, engines: both, repeat: cheapRepeat, usd: estimateModelCost(price, tokens, { engines: both, repeat: cheapRepeat }) }));
	if (items.reduce((sum, item) => sum + item.usd, 0) > budgetUsd) {
		// Nem 1 repetição nos dois motores cabe para todos: só o v3, dos mais baratos para os mais caros, enquanto couber.
		items = [];
		let used = 0;
		for (const price of [...cheap].sort((a, b) => estimateModelCost(a, tokens, { engines: ["v3"], repeat: 1 }) - estimateModelCost(b, tokens, { engines: ["v3"], repeat: 1 }))) {
			const usd = estimateModelCost(price, tokens, { engines: ["v3"], repeat: 1 });
			if (used + usd > budgetUsd) continue;
			items.push({ model: price.model, engines: ["v3"], repeat: 1, usd });
			used += usd;
		}
	}
	let total = items.reduce((sum, item) => sum + item.usd, 0);
	for (const price of strong) {
		let placed = false;
		for (const engines of [both, ["v3"] as BridgeEngine[]]) {
			for (let repeat = Math.min(cheapRepeat, 5); repeat >= 1 && !placed; repeat -= 1) {
				const usd = estimateModelCost(price, tokens, { engines, repeat });
				if (total + usd <= budgetUsd) {
					items.push({ model: price.model, engines, repeat, usd });
					total += usd;
					placed = true;
				}
			}
			if (placed) break;
		}
	}
	return { label: `até US$ ${limitUsd} (planejado com 10% de folga)`, budgetUsd, totalUsd: total, items };
}

const usd = (value: number) => `US$ ${value.toFixed(2)}`;

/** Markdown da estimativa (pt-BR). */
export function formatEstimate(tokens: Record<BridgeEngine, EngineTokens>, options: { budgetUsd: number; prices?: readonly ModelPrice[] }): string {
	const prices = options.prices ?? PRICE_ASSUMPTIONS;
	const rows = estimateTable(tokens, prices);
	const plan = recommendPlan(tokens, options.budgetUsd, prices);
	const lines: string[] = [];
	lines.push("## Estimativa de custo");
	lines.push("");
	lines.push(`Tokens de UMA repetição (10 tarefas), medidos na rodada mock: v2 ${tokens.v2.promptTokens.toLocaleString("pt-BR")} de entrada em ${tokens.v2.steps} passos; v3 ${tokens.v3.promptTokens.toLocaleString("pt-BR")} de entrada em ${tokens.v3.steps} passos.`);
	lines.push(`Margem de ${Math.round((ESTIMATE_MARGIN - 1) * 100)}% por passos extras de modelo real, mais tokens de raciocínio por passo (coluna "raciocínio"). Sem desconto de cache (conservador).`);
	lines.push("");
	lines.push("| Modelo | Preço US$/Mtok (entrada / saída) | raciocínio/passo | repeat 3, v2+v3 | repeat 5, v2+v3 | repeat 3, só v3 | repeat 5, só v3 |");
	lines.push("|---|---|---|---|---|---|---|");
	for (const row of rows) lines.push(`| ${row.price.label} (\`${row.price.model}\`) | ${row.price.promptUsdPerMTok} / ${row.price.completionUsdPerMTok} | ${row.price.extraOutputPerStep} | ${usd(row.repeat3Both)} | ${usd(row.repeat5Both)} | ${usd(row.repeat3V3)} | ${usd(row.repeat5V3)} |`);
	const sum = (pick: (row: EstimateRow) => number) => rows.reduce((total, row) => total + pick(row), 0);
	lines.push(`| **Total (todos)** | | | ${usd(sum((row) => row.repeat3Both))} | ${usd(sum((row) => row.repeat5Both))} | ${usd(sum((row) => row.repeat3V3))} | ${usd(sum((row) => row.repeat5V3))} |`);
	lines.push("");
	lines.push(`Configuração ${plan.label}, total estimado ${usd(plan.totalUsd)}. Motores e repetições valem para a rodada inteira, então modelos com a mesma combinação saem numa rodada só (um disparo do workflow ou um comando por combinação):`);
	for (const item of plan.items) lines.push(`- \`${item.model}\`: ${item.engines.join("+")} × ${item.repeat} repetição(ões) ≈ ${usd(item.usd)}`);
	lines.push("");
	lines.push("Preços são suposições de planejamento (lista pública aproximada, não verificada); o repositório não tem tabela de preços por modelo. O `--max-cost` do CLI usa o custo real que o OpenRouter informa por chamada; nos `claude-*` diretos a Anthropic não informa custo, então ele sai dos tokens com o preço de lista (Haiku 5.5: US$ 0,10 / 0,50 por Mtok; confira e sobrescreva com `--prices`).");
	return lines.join("\n");
}
