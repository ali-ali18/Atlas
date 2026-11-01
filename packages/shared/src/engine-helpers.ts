/**
 * Motor v2 (F3): ajudantes. Regras puras da delegação: parse dos pedidos, repartição do orçamento do pai e a
 * política do bot. O executor mora em `packages/agent-runtime/src/engine-v2/helpers.ts`.
 */
import { DELEGATE_CONTEXT_MAX_CHARS, DELEGATE_GOAL_MAX_CHARS, DELEGATE_MODEL_MAX_CHARS, DELEGATE_TITLE_MAX_CHARS } from "./subagents.js";

export const HELPER_TOOL_NAME = "delegate";
/** Ajudantes rodando ao mesmo tempo (padrão, ajustável por bot em `policyJson.helperMaxParallel`). */
export const HELPER_DEFAULT_PARALLEL = 4;
export const HELPER_MAX_PARALLEL = 8;
/** Tarefas por chamada (as que passam do paralelo esperam a vez). */
export const HELPER_MAX_TASKS_PER_CALL = 12;
/** Fatia do que sobra ao pai que pode ir para os ajudantes; o resto fica para o pai integrar e entregar. */
export const HELPER_POOL_RATIO = 0.6;
export const HELPER_MIN_USD = 0.01;
export const HELPER_MAX_USD = 1;
export const HELPER_MIN_MS = 30_000;
export const HELPER_MAX_MS = 10 * 60_000;
/** Passos de segurança de um ajudante (o orçamento em US$ e tempo é quem encerra). */
export const HELPER_MAX_STEPS = 30;

export type HelperTask = { title?: string; goal: string; context?: string };

export type ParsedHelperTasks = { ok: true; tasks: HelperTask[] } | { ok: false; error: string };

const clean = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/** Valida os args da tool `delegate`. Nunca lança; campo desconhecido falha com a lista do aceito. */
export function parseHelperTasks(args: unknown, maxTasks = HELPER_MAX_TASKS_PER_CALL): ParsedHelperTasks {
	const raw = (args as { tasks?: unknown } | null | undefined)?.tasks;
	if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: `tasks must be an array with 1 to ${maxTasks} items.` };
	if (raw.length > maxTasks) return { ok: false, error: `At most ${maxTasks} tasks per call (got ${raw.length}). Merge related tasks or delegate the rest in a later call.` };
	const extra = Object.keys((args ?? {}) as object).filter((key) => key !== "tasks");
	if (extra.length > 0) return { ok: false, error: `Unknown field(s): ${extra.join(", ")}. Accepted: tasks.` };
	const tasks: HelperTask[] = [];
	for (const [index, item] of raw.entries()) {
		if (!item || typeof item !== "object" || Array.isArray(item)) return { ok: false, error: `tasks[${index}] must be an object with a goal.` };
		const entry = item as Record<string, unknown>;
		const unknown = Object.keys(entry).filter((key) => key !== "title" && key !== "goal" && key !== "context");
		if (unknown.length > 0) return { ok: false, error: `tasks[${index}] has unknown field(s): ${unknown.join(", ")}. Accepted: title, goal, context.` };
		const goal = clean(entry.goal);
		if (!goal) return { ok: false, error: `tasks[${index}].goal is required: what the helper must find out, self-contained.` };
		if (goal.length > DELEGATE_GOAL_MAX_CHARS) return { ok: false, error: `tasks[${index}].goal is ${goal.length} characters; the maximum is ${DELEGATE_GOAL_MAX_CHARS}.` };
		const context = clean(entry.context);
		if (context.length > DELEGATE_CONTEXT_MAX_CHARS) return { ok: false, error: `tasks[${index}].context is ${context.length} characters; the maximum is ${DELEGATE_CONTEXT_MAX_CHARS}.` };
		const title = clean(entry.title);
		if (title.length > DELEGATE_TITLE_MAX_CHARS) return { ok: false, error: `tasks[${index}].title is ${title.length} characters; the maximum is ${DELEGATE_TITLE_MAX_CHARS}.` };
		tasks.push({ goal, ...(title ? { title } : {}), ...(context ? { context } : {}) });
	}
	return { ok: true, tasks };
}

export type HelperBudgetPlan =
	| { ok: true; perTask: { costUsd: number; activeMs: number }; poolUsd: number; waves: number }
	| { ok: false; reason: string };

/**
 * Orçamento de cada ajudante: fatia do que SOBRA ao pai. A soma dos ajudantes nunca passa de `HELPER_POOL_RATIO`
 * do restante (então nunca passa do pai) e o tempo considera as levas (o paralelo limita quantos rodam juntos).
 */
export function planHelperBudgets(input: { taskCount: number; maxParallel: number; remainingUsd: number; remainingMs: number }): HelperBudgetPlan {
	const count = Math.max(1, Math.floor(input.taskCount));
	const parallel = Math.min(count, Math.max(1, Math.floor(input.maxParallel)));
	const waves = Math.ceil(count / parallel);
	const poolUsd = Math.max(0, input.remainingUsd) * HELPER_POOL_RATIO;
	const costUsd = Math.min(HELPER_MAX_USD, poolUsd / count);
	if (costUsd < HELPER_MIN_USD) {
		return { ok: false, reason: `not enough budget left in this run to delegate ${count} task(s) (US$ ${input.remainingUsd.toFixed(3)} left); do it yourself with what you have, or delegate fewer tasks.` };
	}
	const activeMs = Math.min(HELPER_MAX_MS, Math.floor((Math.max(0, input.remainingMs) * HELPER_POOL_RATIO) / waves));
	if (activeMs < HELPER_MIN_MS) {
		return { ok: false, reason: "not enough time left in this run to delegate; answer with what you already have." };
	}
	return { ok: true, perTask: { costUsd, activeMs }, poolUsd, waves };
}

export type HelperPolicy = { helperModel: string | null; helperMaxParallel: number };

const MODEL_ID_PATTERN = /^[A-Za-z0-9_.:/~+-]+$/;

/** Id de modelo bem formado (tamanho e caracteres); não diz se o modelo existe no catálogo. */
export function isWellFormedModelId(value: string): boolean {
	return value.length > 0 && value.length <= DELEGATE_MODEL_MAX_CHARS && MODEL_ID_PATTERN.test(value);
}

/** `policyJson.helperModel` ("forte coordena, barato trabalha") e `helperMaxParallel`. Valor inválido cai no padrão. */
export function readHelperPolicy(policyJson: unknown): HelperPolicy {
	const policy = policyJson && typeof policyJson === "object" && !Array.isArray(policyJson) ? (policyJson as Record<string, unknown>) : {};
	const model = typeof policy.helperModel === "string" ? policy.helperModel.trim() : "";
	const parallel = policy.helperMaxParallel;
	return {
		helperModel: model && model.length <= DELEGATE_MODEL_MAX_CHARS && MODEL_ID_PATTERN.test(model) ? model : null,
		helperMaxParallel:
			typeof parallel === "number" && Number.isFinite(parallel) ? Math.min(HELPER_MAX_PARALLEL, Math.max(1, Math.floor(parallel))) : HELPER_DEFAULT_PARALLEL,
	};
}
