import type { ModelProvider } from "../model-ref.js";

// Escolha de modelo por PAPEL (03 §8). Tipos puros: nenhuma conta, chave ou
// modelo fixo mora aqui; as cadeias chegam por configuração.

export const MODEL_ROLES = ["main", "helper", "code", "vision", "sleep", "classifier"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

/** Um modelo de uma cadeia. `model` é o slug do provedor (no OpenRouter, `vendor/modelo`). */
export type ModelChainEntry = { provider: ModelProvider; model: string };

/** Cadeia de reserva por papel: a primeira entrada é a preferida, as seguintes são a reserva em ordem. */
export type RoleChains = Record<ModelRole, ModelChainEntry[]>;

export type ProviderHealthReason = "rate_limit" | "quota" | "down";

/** Provedor em quarentena até `until` (ms epoch). A chave é o nome do provedor. */
export type ProviderHealthState = { until: number; reason: ProviderHealthReason };
export type ProviderHealth = Readonly<Record<string, ProviderHealthState | undefined>>;

export const SPEND_PERIODS = ["day", "week", "month"] as const;
export type SpendPeriod = (typeof SPEND_PERIODS)[number];
export type SpendScope = "bot" | "account";

/** Tetos OPCIONAIS do dono, em US$. Ausente = sem teto: o padrão é nunca parar por custo. */
export type SpendCeilings = {
	bot?: Partial<Record<SpendPeriod, number>>;
	account?: Partial<Record<SpendPeriod, number>>;
};

/** Gasto acumulado em US$ por período, no mesmo recorte dos tetos. */
export type SpendSoFar = {
	bot?: Partial<Record<SpendPeriod, number>>;
	account?: Partial<Record<SpendPeriod, number>>;
};

export type SkipReason = ProviderHealthReason;
export type SkippedEntry = { entry: ModelChainEntry; reason: SkipReason; until: number };

export type NoModelReason =
	| { kind: "no_chain" }
	| { kind: "all_unavailable"; skipped: SkippedEntry[] }
	| { kind: "ceiling"; period: SpendPeriod; source: SpendScope; limitUsd: number; spentUsd: number };

export type PickModelResult = { entry: ModelChainEntry; skipped: SkippedEntry[] } | { none: NoModelReason };
