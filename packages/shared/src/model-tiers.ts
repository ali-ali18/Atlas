import { isValidConfigModelId, MAX_TIER_MODELS, MODEL_TIERS, type ModelTier } from "./account-config.js";

/**
 * Modelos por dificuldade ("Fácil", "Média", "Difícil"). Cada nível guarda até
 * `MAX_TIER_MODELS` modelos: o 1º é o principal, os outros entram quando ele
 * falha. Nível vazio herda o modelo padrão e as reservas (nada muda para quem
 * nunca configurou). Funções puras.
 */

export type ModelTiers = Partial<Record<ModelTier, string[]>>;

export const MODEL_TIER_LABELS: Record<ModelTier, string> = {
	easy: "Fácil",
	medium: "Média",
	hard: "Difícil",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Leitura tolerante: ids válidos, sem repetição, até 3 por nível; nível sem modelo some. */
export function normalizeModelTiers(raw: unknown): ModelTiers {
	if (!isRecord(raw)) return {};
	const out: ModelTiers = {};
	for (const tier of MODEL_TIERS) {
		const list = raw[tier];
		if (!Array.isArray(list)) continue;
		const clean: string[] = [];
		for (const item of list) {
			if (isValidConfigModelId(item, false) && !clean.includes(item)) clean.push(item);
			if (clean.length >= MAX_TIER_MODELS) break;
		}
		if (clean.length > 0) out[tier] = clean;
	}
	return out;
}

export function hasModelTiers(tiers: ModelTiers | null | undefined): boolean {
	return !!tiers && MODEL_TIERS.some((tier) => (tiers[tier]?.length ?? 0) > 0);
}

/** Nível acima (Fácil, Média, Difícil); `null` no Difícil. */
export function nextTierUp(tier: ModelTier): ModelTier | null {
	const index = MODEL_TIERS.indexOf(tier);
	return MODEL_TIERS[index + 1] ?? null;
}

/** Lista do nível, ou a herdada (padrão + reservas) quando o nível está vazio. */
export function tierModelList(
	tiers: ModelTiers | null | undefined,
	tier: ModelTier,
	inherited: readonly string[],
): string[] {
	const own = tiers?.[tier];
	return own && own.length > 0 ? [...own] : [...inherited];
}

/** Modelos cadastrados nos níveis, sem repetição, na ordem Fácil, Média, Difícil. */
export function registeredTierModels(tiers: ModelTiers | null | undefined): string[] {
	const seen = new Set<string>();
	for (const tier of MODEL_TIERS) for (const id of tiers?.[tier] ?? []) seen.add(id);
	return [...seen];
}

/** Nível do bot vence o da conta; nível que o bot não definiu herda o da conta. */
export function mergeModelTiers(
	account: ModelTiers | null | undefined,
	bot: ModelTiers | null | undefined,
): ModelTiers {
	const out: ModelTiers = {};
	for (const tier of MODEL_TIERS) {
		const list = bot?.[tier]?.length ? bot[tier] : account?.[tier];
		if (list?.length) out[tier] = [...list];
	}
	return out;
}

/** Modelos por dificuldade do bot em `Bot.policyJson.modelTiers` (vazio = herda da conta). */
export function readBotModelTiers(policyJson: unknown): ModelTiers {
	if (!isRecord(policyJson)) return {};
	return normalizeModelTiers(policyJson.modelTiers);
}

/** Nova política com os níveis do bot trocados, sem perder as outras chaves. */
export function withBotModelTiers(policyJson: unknown, tiers: ModelTiers | null): Record<string, unknown> {
	const base = isRecord(policyJson) ? { ...policyJson } : {};
	const clean = normalizeModelTiers(tiers);
	if (hasModelTiers(clean)) base.modelTiers = clean;
	else delete base.modelTiers;
	return base;
}
