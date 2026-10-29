/**
 * Orçamento adaptativo do run (§5.3 do plano): limites combinados em vez de
 * um corte seco por número de passos. Resolução: request > bot > padrões.
 */
import type { RunUsage } from "@workspace/shared";

export type AgentBudgetPolicy = {
	softMaxSteps?: number;
	hardMaxSteps?: number;
	maxWallMs?: number;
	maxTokens?: number;
	/** Custo máximo por execução em USD (conta). Ausente = sem limite. */
	maxCostUsd?: number;
	maxCallsPerTool?: Record<string, number>;
	extensionSteps?: number;
	skills?: {
		autoPromote?: boolean;
		maxContextChars?: number;
	};
};

export type AgentBudget = {
	/** Passo onde o modelo avalia (concluir ou continuar). >= hard = sem fase soft. */
	softMaxSteps: number;
	/** Teto de decisões do modelo. */
	hardMaxSteps: number;
	/** Teto de relógio por run. 0 = sem limite. */
	maxWallMs: number;
	/** Teto de tokens (prompt+completion). undefined = só registra. */
	maxTokens?: number;
	/** Teto de execuções por ferramenta. undefined = sem teto. */
	maxCallsPerTool?: Record<string, number>;
	/** Passos extras após avaliação soft com evidência. Pode repetir até o teto. */
	extensionSteps: number;
	/** Teto de custo em USD por run. undefined = sem limite; aplicado pelo governo do run (run-governor). */
	maxCostUsd?: number;
};

export const BUDGET_HARD_CAP = 300;
export const BUDGET_SOFT_DEFAULT = 24;
export const BUDGET_WALL_DEFAULT_MS = 30 * 60 * 1000;
export const BUDGET_EXTENSION_DEFAULT = 24;
/**
 * F4 — travas por tool, nunca globais. 3 falhas seguidas da mesma tool a
 * bloqueiam no run (o modelo é avisado e segue com alternativas); o run só
 * aborta com 6 falhas seguidas envolvendo 3+ tools distintas. `edit_file`,
 * `write_file` e `read_file` ficam fora do bloqueio por tool (ver `tool-failure.ts`).
 */
export const TOOL_FAILURE_BLOCK_AFTER = 3;
/** Passos seguidos sem chamar a tool bloqueada depois dos quais o bloqueio expira. */
export const TOOL_BLOCK_EXPIRY_STEPS = 3;
export const RUN_ABORT_CONSECUTIVE_FAILURES = 6;
export const RUN_ABORT_DISTINCT_TOOLS = 3;

function positiveInt(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	const floored = Math.floor(value);
	return floored > 0 ? floored : undefined;
}

function positiveMs(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return value > 0 ? Math.floor(value) : undefined;
}

/** Normaliza política vinda do bot/banco (unknown) sem nunca explodir. */
export function parseBudgetPolicy(raw: unknown): AgentBudgetPolicy {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const record = raw as Record<string, unknown>;
	const policy: AgentBudgetPolicy = {};
	const soft = positiveInt(record.softMaxSteps);
	if (soft !== undefined) policy.softMaxSteps = soft;
	const hard = positiveInt(record.hardMaxSteps);
	if (hard !== undefined) policy.hardMaxSteps = hard;
	const wall = positiveMs(record.maxWallMs);
	if (wall !== undefined) policy.maxWallMs = wall;
	const tokens = positiveInt(record.maxTokens);
	if (tokens !== undefined) policy.maxTokens = tokens;
	const cost = record.maxCostUsd;
	if (typeof cost === "number" && Number.isFinite(cost) && cost > 0) policy.maxCostUsd = cost;
	const ext = positiveInt(record.extensionSteps);
	if (ext !== undefined) policy.extensionSteps = ext;
	if (
		record.maxCallsPerTool &&
		typeof record.maxCallsPerTool === "object" &&
		!Array.isArray(record.maxCallsPerTool)
	) {
		const caps: Record<string, number> = {};
		for (const [name, cap] of Object.entries(
			record.maxCallsPerTool as Record<string, unknown>,
		)) {
			const parsed = positiveInt(cap);
			if (parsed !== undefined) caps[name] = parsed;
		}
		if (Object.keys(caps).length > 0) policy.maxCallsPerTool = caps;
	}
	if (
		record.skills &&
		typeof record.skills === "object" &&
		!Array.isArray(record.skills)
	) {
		const rawSkills = record.skills as Record<string, unknown>;
		const skills: NonNullable<AgentBudgetPolicy["skills"]> = {};
		if (typeof rawSkills.autoPromote === "boolean") {
			skills.autoPromote = rawSkills.autoPromote;
		}
		const maxContextChars = positiveInt(rawSkills.maxContextChars);
		if (maxContextChars !== undefined) {
			skills.maxContextChars = maxContextChars;
		}
		if (Object.keys(skills).length > 0) policy.skills = skills;
	}
	return policy;
}

export function resolveBudget(input: {
	/** maxSteps do request (legado = teto duro). */
	maxSteps?: number;
	policy?: AgentBudgetPolicy | null;
}): AgentBudget {
	const policy = input.policy ?? {};
	const hard = Math.max(
		1,
		Math.min(
			BUDGET_HARD_CAP,
			positiveInt(policy.hardMaxSteps) ??
				positiveInt(input.maxSteps) ??
				BUDGET_HARD_CAP,
		),
	);
	const softRaw = positiveInt(policy.softMaxSteps) ?? BUDGET_SOFT_DEFAULT;
	const softMaxSteps = Math.max(1, Math.min(softRaw, hard));
	const wall = positiveMs(policy.maxWallMs) ?? BUDGET_WALL_DEFAULT_MS;
	return {
		softMaxSteps,
		hardMaxSteps: hard,
		maxWallMs: wall,
		maxTokens: positiveInt(policy.maxTokens),
		...(typeof policy.maxCostUsd === "number" && policy.maxCostUsd > 0 ? { maxCostUsd: policy.maxCostUsd } : {}),
		maxCallsPerTool: policy.maxCallsPerTool,
		extensionSteps:
			positiveInt(policy.extensionSteps) ?? BUDGET_EXTENSION_DEFAULT,
	};
}

/** Janela de fechamento: o run pai para de iniciar passos assim que falta isto para o teto de relógio (o resumo final cabe aqui). */
export function wrapUpWindowMs(maxWallMs: number): number {
	if (!(maxWallMs > 0)) return 0;
	return Math.min(75_000, Math.floor(maxWallMs * 0.05));
}

/**
 * Âncoras do teto de relógio por EXECUÇÃO. O teto conta só tempo ativo: o que
 * já foi gasto em execuções anteriores vem do checkpoint (`activeElapsedMs`) e
 * o resto desta execução corre a partir de `now`. Pausa e fila não contam.
 * Sem checkpoint (run novo) vale `runStartedAt` (início real do run).
 */
export function wallClockAnchors(input: {
	maxWallMs: number;
	now: number;
	runStartedAt?: number;
	/** Nulo/ausente = run sem checkpoint (primeira execução). */
	restored?: { activeElapsedMs?: number } | null;
}): { baseMs: number; executionStartMs: number; deadlineAtMs: number | undefined } {
	const resumed = !!input.restored;
	const baseMs = resumed ? Math.max(0, input.restored?.activeElapsedMs ?? 0) : 0;
	const executionStartMs = resumed ? input.now : (input.runStartedAt ?? input.now);
	return {
		baseMs,
		executionStartMs,
		deadlineAtMs:
			input.maxWallMs > 0
				? executionStartMs + Math.max(0, input.maxWallMs - baseMs)
				: undefined,
	};
}

export type TokenUsage = RunUsage;

function sumOptional(a?: number, b?: number): number | undefined {
	return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
}

export function addUsage(
	total: TokenUsage,
	usage?: {
		promptTokens?: number;
		completionTokens?: number;
		totalTokens?: number;
		cachedTokens?: number;
		cacheWriteTokens?: number;
		costUsd?: number;
		/** Chamadas deste uso cujo custo o provider não informou (nunca conta como 0). */
		costUnknownCalls?: number;
		planCalls?: number;
	},
): TokenUsage {
	const prompt = usage?.promptTokens ?? 0;
	const completion = usage?.completionTokens ?? 0;
	const costUsd = sumOptional(total.costUsd, usage?.costUsd);
	const cachedTokens = sumOptional(total.cachedTokens, usage?.cachedTokens);
	const cacheWriteTokens = sumOptional(total.cacheWriteTokens, usage?.cacheWriteTokens);
	const costUnknownCalls = (total.costUnknownCalls ?? 0) + (usage?.costUnknownCalls ?? 0);
	const planCalls = (total.planCalls ?? 0) + (usage?.planCalls ?? 0);
	return {
		promptTokens: total.promptTokens + prompt,
		completionTokens: total.completionTokens + completion,
		totalTokens: total.totalTokens + (usage?.totalTokens ?? prompt + completion),
		...(costUsd !== undefined ? { costUsd } : {}),
		...(costUnknownCalls > 0 ? { costUnknownCalls } : {}),
		...(planCalls > 0 ? { planCalls } : {}),
		...(cachedTokens !== undefined ? { cachedTokens } : {}),
		...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
		...(total.computer ? { computer: total.computer } : {}),
	};
}

export function emptyUsage(): TokenUsage {
	return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}
