/**
 * Limites por rotina (motor v3, decisão D4 do dono, 03/11). Puro: sem I/O.
 * - Passos: run sem humano para em 40 passos por execução por padrão; o dono pode trocar por rotina (faixa abaixo).
 * - US$: só existe se o dono configurar (sem valor padrão).
 * No limite o run não morre: guarda o ponto e pergunta ao dono "Continuo?" (ver `StepLimitWait`).
 */

/** Passos por execução: abaixo de 5 a rotina mal começa; 200 é o teto de segurança do motor. */
export const ROUTINE_MAX_STEPS_MIN = 5;
export const ROUTINE_MAX_STEPS_MAX = 200;
/** Gasto por execução em US$ (centavos já contam; acima de 50 por execução é engano de digitação). */
export const ROUTINE_MAX_COST_MIN_USD = 0.01;
export const ROUTINE_MAX_COST_MAX_USD = 50;

export type RoutineLimits = {
	/** Passos por execução (ausente = padrão do motor: 40 sem humano). */
	maxSteps?: number;
	/** Gasto máximo por execução em US$ (ausente = sem teto em US$). */
	maxCostUsd?: number;
};

/** Patch: número troca, `null` volta ao padrão, ausente mantém. */
export type RoutineLimitsPatch = { maxSteps?: number | null; maxCostUsd?: number | null };

const ACCEPTED_FIELDS = ["maxSteps", "maxCostUsd"] as const;

export type RoutineLimitsParse = { ok: true; patch: RoutineLimitsPatch | null } | { ok: false; error: string };

function stepsError(value: unknown): string | null {
	if (typeof value !== "number" || !Number.isInteger(value)) return `maxSteps precisa ser um número inteiro entre ${ROUTINE_MAX_STEPS_MIN} e ${ROUTINE_MAX_STEPS_MAX}`;
	if (value < ROUTINE_MAX_STEPS_MIN || value > ROUTINE_MAX_STEPS_MAX) return `maxSteps fora da faixa: use de ${ROUTINE_MAX_STEPS_MIN} a ${ROUTINE_MAX_STEPS_MAX} passos`;
	return null;
}

function costError(value: unknown): string | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return `maxCostUsd precisa ser um número entre ${ROUTINE_MAX_COST_MIN_USD} e ${ROUTINE_MAX_COST_MAX_USD}`;
	if (value < ROUTINE_MAX_COST_MIN_USD || value > ROUTINE_MAX_COST_MAX_USD) return `maxCostUsd fora da faixa: use de US$ ${ROUTINE_MAX_COST_MIN_USD} a US$ ${ROUTINE_MAX_COST_MAX_USD}`;
	return null;
}

/**
 * Valida o campo `limits` vindo da API ou da tool. `null` = volta tudo ao padrão. Campo desconhecido falha com a lista
 * dos aceitos (nunca é descartado em silêncio).
 */
export function parseRoutineLimitsInput(raw: unknown): RoutineLimitsParse {
	if (raw === null) return { ok: true, patch: null };
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: `limits precisa ser um objeto com ${ACCEPTED_FIELDS.join(" e/ou ")}, ou null` };
	const record = raw as Record<string, unknown>;
	const unknown = Object.keys(record).filter((key) => !(ACCEPTED_FIELDS as readonly string[]).includes(key));
	if (unknown.length > 0) return { ok: false, error: `campo desconhecido em limits: ${unknown.join(", ")}. Aceitos: ${ACCEPTED_FIELDS.join(", ")}` };
	const patch: RoutineLimitsPatch = {};
	if ("maxSteps" in record) {
		if (record.maxSteps === null) patch.maxSteps = null;
		else {
			const error = stepsError(record.maxSteps);
			if (error) return { ok: false, error };
			patch.maxSteps = record.maxSteps as number;
		}
	}
	if ("maxCostUsd" in record) {
		if (record.maxCostUsd === null) patch.maxCostUsd = null;
		else {
			const error = costError(record.maxCostUsd);
			if (error) return { ok: false, error };
			patch.maxCostUsd = Math.round((record.maxCostUsd as number) * 100) / 100;
		}
	}
	return { ok: true, patch };
}

/** Lê o que está gravado (`routines.limitsJson`): valor fora da faixa é ignorado (vale o padrão). */
export function parseStoredRoutineLimits(raw: unknown): RoutineLimits | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const record = raw as Record<string, unknown>;
	const out: RoutineLimits = {};
	if (stepsError(record.maxSteps) === null) out.maxSteps = record.maxSteps as number;
	if (costError(record.maxCostUsd) === null) out.maxCostUsd = record.maxCostUsd as number;
	return Object.keys(out).length > 0 ? out : undefined;
}

/** Aplica o patch ao que está gravado. `undefined` = sem limites próprios (coluna vazia). */
export function applyRoutineLimitsPatch(current: RoutineLimits | undefined, patch: RoutineLimitsPatch | null): RoutineLimits | undefined {
	if (patch === null) return undefined;
	const next: RoutineLimits = { ...(current ?? {}) };
	if (patch.maxSteps === null) delete next.maxSteps;
	else if (patch.maxSteps !== undefined) next.maxSteps = patch.maxSteps;
	if (patch.maxCostUsd === null) delete next.maxCostUsd;
	else if (patch.maxCostUsd !== undefined) next.maxCostUsd = patch.maxCostUsd;
	return Object.keys(next).length > 0 ? next : undefined;
}

const usd = (value: number) => `US$ ${value.toFixed(2).replace(".", ",")}`;

/** Resumo em frase para o dono ("Até 60 passos · até US$ 0,50 por execução"). */
export function formatRoutineLimitsSummary(limits: RoutineLimits | undefined, defaultSteps = 40): string {
	const steps = `Até ${limits?.maxSteps ?? defaultSteps} passos`;
	return limits?.maxCostUsd !== undefined ? `${steps} · até ${usd(limits.maxCostUsd)} por execução` : `${steps} por execução · sem teto em US$`;
}

/**
 * Run sem humano parado no limite (motor v3), guardado no checkpoint (`engineV3.limitWait`). O cartão "Continuo?"
 * grava `outcome`; o run retoma do checkpoint e lê a decisão.
 */
export type StepLimitWait = {
	cardId: string;
	kind: "steps" | "cost";
	/** Passos (ou US$) que "Continuar" acrescenta: o mesmo limite de novo. */
	steps: number;
	costUsd?: number;
	outcome?: "continue" | "stop";
};

export function parseStepLimitWait(raw: unknown): StepLimitWait | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const record = raw as Record<string, unknown>;
	if (typeof record.cardId !== "string" || !record.cardId || (record.kind !== "steps" && record.kind !== "cost")) return undefined;
	if (typeof record.steps !== "number" || !Number.isInteger(record.steps) || record.steps < 1) return undefined;
	const costUsd = typeof record.costUsd === "number" && Number.isFinite(record.costUsd) && record.costUsd > 0 ? record.costUsd : undefined;
	const outcome = record.outcome === "continue" || record.outcome === "stop" ? record.outcome : undefined;
	return { cardId: record.cardId, kind: record.kind, steps: record.steps, ...(costUsd !== undefined ? { costUsd } : {}), ...(outcome ? { outcome } : {}) };
}

/** Texto do cartão "Continuo?" (pt-BR, sem nomes internos). */
export function stepLimitCardText(wait: Pick<StepLimitWait, "kind" | "steps" | "costUsd">): { title: string; description: string } {
	if (wait.kind === "cost" && wait.costUsd !== undefined) {
		return {
			title: `Cheguei no limite de ${usd(wait.costUsd)} desta execução. Continuo?`,
			description: `Guardei onde parei. Continuar retoma daqui com mais ${usd(wait.costUsd)}; Agora não encerra e conta o que ficou feito.`,
		};
	}
	return {
		title: `Cheguei no limite de ${wait.steps} passos. Continuo?`,
		description: `Guardei onde parei. Continuar retoma daqui com mais ${wait.steps} passos; Agora não encerra e conta o que ficou feito.`,
	};
}
