import { MODEL_TIERS, nextTierUp, parseModelRef, tierModelList, type ModelTier, type ModelTiers } from "@workspace/shared";
import type { ToolOutcome } from "./progress.js";

/**
 * Modelos por dificuldade dentro do run (modo Automático): lista de cada nível
 * já com a herança aplicada, escolha do próximo nível e o sinal de "a mesma
 * ferramenta segue sem render". Puro; `computer-use.ts` só aplica o resultado.
 */

export type ModelTiersRuntime = {
	/** Modelos de cada nível (já mesclados conta + bot e filtrados pelos provedores disponíveis). */
	tiers: ModelTiers;
	/** Classificar a dificuldade com o revisor (Jev); falha cai nas regras. */
	classifyWithReviewer?: boolean;
};

export type TierPlan = Record<ModelTier, string[]>;

/** Cada nível com ao menos um modelo: o vazio herda `[modelo do run, ...reservas]`. */
export function buildTierPlan(tiers: ModelTiers, inherited: readonly string[]): TierPlan {
	return Object.fromEntries(MODEL_TIERS.map((tier) => [tier, tierModelList(tiers, tier, inherited)])) as TierPlan;
}

/**
 * Modelo principal do nível e as reservas dele. A reserva usa a rota do OpenRouter,
 * então só vale quando o principal também é do OpenRouter.
 */
export function modelsForTier(plan: TierPlan, tier: ModelTier): { model: string; fallbacks: string[] } {
	const [model, ...rest] = plan[tier];
	if (!model) return { model: "", fallbacks: [] };
	const viaOpenRouter = parseModelRef(model).provider === "openrouter";
	return {
		model,
		fallbacks: viaOpenRouter ? rest.filter((id) => id !== model && parseModelRef(id).provider === "openrouter") : [],
	};
}

/**
 * Próximo nível acima com um modelo principal diferente do atual. Nível acima que
 * repete o modelo em uso não ajuda: pula para o seguinte; `null` = nada mais forte.
 */
export function nextEscalationTier(plan: TierPlan, current: ModelTier, currentModel: string): ModelTier | null {
	for (let tier = nextTierUp(current); tier; tier = nextTierUp(tier)) {
		const { model } = modelsForTier(plan, tier);
		if (model && model !== currentModel) return tier;
	}
	return null;
}

/** Quantas respostas ruins seguidas da mesma ferramenta pedem um modelo mais forte. */
export const WEAK_RESULTS_TO_ESCALATE = 3;

/**
 * A mesma ferramenta falhou (erro que não é de argumento) ou voltou vazia nas
 * últimas `threshold` chamadas, contando só o que veio depois de `sinceIndex`.
 */
export function repeatedWeakResults(
	outcomes: readonly ToolOutcome[],
	name: string,
	sinceIndex = 0,
	threshold = WEAK_RESULTS_TO_ESCALATE,
): boolean {
	const own = outcomes.slice(sinceIndex).filter((outcome) => outcome.name === name);
	if (own.length < threshold) return false;
	return own.slice(-threshold).every((outcome) => (outcome.ok ? outcome.empty === true : outcome.kind !== "argument"));
}

export type OngoingTierDecision = {
	tier: ModelTier;
	/** Manter o modelo padrão do bot em vez do modelo do nível (o nível só tem o modelo barato). */
	keepDefault: boolean;
};

/**
 * Turno que continua uma tarefa (ver `ongoingTaskReason`) nunca roda no modelo
 * mais barato: o nível sobe no mínimo para Média e, se a Média também é o
 * modelo do Fácil, fica o modelo padrão do bot. Conversa solta segue a escolha
 * original. Puro; `computer-use.ts` só aplica.
 */
export function holdTierForOngoingTask(input: {
	chosen: ModelTier;
	ongoing: boolean;
	plan: TierPlan;
	/** Modelo padrão do run (o do bot), usado antes do nível ser aplicado. */
	defaultModel: string;
}): OngoingTierDecision {
	if (!input.ongoing) return { tier: input.chosen, keepDefault: false };
	const tier = MODEL_TIERS.indexOf(input.chosen) < MODEL_TIERS.indexOf("medium") ? "medium" : input.chosen;
	const cheapest = modelsForTier(input.plan, "easy").model;
	const strongest = modelsForTier(input.plan, "hard").model;
	// Todos os níveis no mesmo modelo = escolha explícita do usuário: respeita.
	const userUsesStrongerModel = strongest !== cheapest;
	const keepDefault =
		userUsesStrongerModel && cheapest !== input.defaultModel && modelsForTier(input.plan, tier).model === cheapest;
	return { tier, keepDefault };
}
