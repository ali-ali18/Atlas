/**
 * Plano antes de agir (`propose_plan`): para tarefas grandes o bot propõe passos e espera o "Aprovar plano".
 * Funções puras (sem I/O): validação do que o modelo envia, leitura tolerante do cartão gravado, a lista de
 * passos que o plano aprovado semeia e o ajuste por bot (`Bot.policyJson.planMode`, padrão ligado).
 * Aprovar o plano NÃO aprova escritas: cada escrita segue o fluxo normal de autonomia e confirmação.
 */
import type { TaskListItem } from "./task-list.js";

export const PLAN_STEP_KINDS = ["read", "write", "ask", "other"] as const;
export type PlanStepKind = (typeof PLAN_STEP_KINDS)[number];
export type PlanStep = { text: string; kind: PlanStepKind };
export type PlanInfo = { title: string; steps: PlanStep[]; needs?: string[]; risks?: string };

export const PLAN_MAX_STEPS = 20;
export const PLAN_MAX_NEEDS = 8;
export const PLAN_TITLE_MAX_CHARS = 120;
export const PLAN_STEP_MAX_CHARS = 160;
export const PLAN_NEED_MAX_CHARS = 160;
export const PLAN_RISKS_MAX_CHARS = 400;

/** Início do resultado de `propose_plan` enquanto o cartão espera; o inspetor e o portão reconhecem por aqui. */
export const PLAN_PENDING_RESULT = "Plan card shown to the user; waiting for approval.";
export const PLAN_APPROVED_RESULT = "The user approved the plan.";
export const PLAN_ADJUST_RESULT = "The user did not approve the plan as written.";

/** Desfecho gravado no cartão do plano (`outcome.detail`): a UI e o inspetor leem estas frases. */
export const PLAN_OUTCOME_APPROVED = "plano aprovado";
export const PLAN_OUTCOME_ADJUSTED = "ajuste pedido";
export const PLAN_OUTCOME_CANCELLED = "plano cancelado";

/** Rascunho do composer ao tocar em "Ajustar" no cartão do plano. */
export const PLAN_ADJUST_DRAFT = "Ajuste no plano: ";

const oneLine = (value: unknown, max: number): string => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");
const isKind = (value: unknown): value is PlanStepKind => (PLAN_STEP_KINDS as readonly unknown[]).includes(value);

/** Valida os argumentos de `propose_plan`. Erros em inglês, para o modelo corrigir. */
export function normalizePlanInput(args: Record<string, unknown>): PlanInfo {
	const title = oneLine(args.title, PLAN_TITLE_MAX_CHARS);
	if (!title) throw new Error("title must be a short non-empty string.");
	if (!Array.isArray(args.steps) || args.steps.length === 0) throw new Error("steps must be a non-empty list of { text, kind }.");
	if (args.steps.length > PLAN_MAX_STEPS) throw new Error(`Too many steps (max ${PLAN_MAX_STEPS}). Merge or drop steps.`);
	const steps: PlanStep[] = args.steps.map((entry, index) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`steps[${index}] must be an object { text, kind }.`);
		const raw = entry as Record<string, unknown>;
		const text = oneLine(raw.text, PLAN_STEP_MAX_CHARS);
		if (!text) throw new Error(`steps[${index}].text must be a non-empty string.`);
		const kind = raw.kind === undefined ? "other" : raw.kind;
		if (!isKind(kind)) throw new Error(`steps[${index}].kind must be one of: ${PLAN_STEP_KINDS.join(", ")}.`);
		return { text, kind };
	});
	const needs = Array.isArray(args.needs) ? args.needs.map((item) => oneLine(item, PLAN_NEED_MAX_CHARS)).filter(Boolean).slice(0, PLAN_MAX_NEEDS) : [];
	const risks = oneLine(args.risks, PLAN_RISKS_MAX_CHARS);
	return { title, steps, ...(needs.length > 0 ? { needs } : {}), ...(risks ? { risks } : {}) };
}

/** Leitura tolerante do que foi gravado no cartão ou na intenção pendente. */
export function parsePlanInfo(raw: unknown): PlanInfo | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const row = raw as Record<string, unknown>;
	const title = oneLine(row.title, PLAN_TITLE_MAX_CHARS);
	if (!title || !Array.isArray(row.steps)) return undefined;
	const steps: PlanStep[] = [];
	for (const entry of row.steps.slice(0, PLAN_MAX_STEPS)) {
		if (!entry || typeof entry !== "object") continue;
		const text = oneLine((entry as Record<string, unknown>).text, PLAN_STEP_MAX_CHARS);
		const kind = (entry as Record<string, unknown>).kind;
		if (text) steps.push({ text, kind: isKind(kind) ? kind : "other" });
	}
	if (steps.length === 0) return undefined;
	const needs = Array.isArray(row.needs) ? row.needs.map((item) => oneLine(item, PLAN_NEED_MAX_CHARS)).filter(Boolean).slice(0, PLAN_MAX_NEEDS) : [];
	const risks = oneLine(row.risks, PLAN_RISKS_MAX_CHARS);
	return { title, steps, ...(needs.length > 0 ? { needs } : {}), ...(risks ? { risks } : {}) };
}

/** Passos do plano aprovado como lista de tarefas: o primeiro em andamento e o resto pendente. */
export function planToTaskList(plan: PlanInfo): TaskListItem[] {
	return plan.steps.map((step, index) => ({ content: step.text, status: index === 0 ? "in_progress" : "pending" }));
}

/** Texto do plano para o resultado da ferramenta e para o inspetor (uma linha por passo). */
export function renderPlanText(plan: PlanInfo): string {
	const lines = plan.steps.map((step, index) => `${index + 1}. [${step.kind}] ${step.text}`);
	return [plan.title, ...lines, ...(plan.needs?.length ? [`Needs from the user: ${plan.needs.join("; ")}`] : []), ...(plan.risks ? [`Risks: ${plan.risks}`] : [])].join("\n");
}

/** Resultado da ferramenta quando o usuário aprova: o plano entra na conversa e a lista de passos já está montada. */
export function planApprovedResult(plan: PlanInfo): string {
	return [
		PLAN_APPROVED_RESULT,
		renderPlanText(plan),
		"The steps are already in your task list. Execute them in order and keep the list updated with update_task_list.",
		"Approving the plan does NOT approve individual writes: each write still follows the normal approval flow.",
	].join("\n");
}

/** Resultado da ferramenta quando o usuário pede mudanças (ou escreve outra coisa) em vez de aprovar. */
export function planAdjustResult(feedback: string): string {
	return [
		PLAN_ADJUST_RESULT,
		`The user replied: ${feedback.replace(/\s+/g, " ").trim().slice(0, 1500)}`,
		"If it refines the plan, revise it and call propose_plan again. If it is an unrelated request, handle that instead and drop this plan. Do not execute writes from the old plan.",
	].join("\n");
}

/** "Planejar antes de tarefas grandes": ligado por padrão; só `planMode: false` desliga. */
export function readPlanMode(policyJson: unknown): boolean {
	if (!policyJson || typeof policyJson !== "object" || Array.isArray(policyJson)) return true;
	return (policyJson as Record<string, unknown>).planMode !== false;
}

/** Nova política com o ajuste trocado, sem perder as outras chaves. Ligado = chave removida (padrão). */
export function withPlanMode(policyJson: unknown, enabled: boolean): Record<string, unknown> {
	const base = policyJson && typeof policyJson === "object" && !Array.isArray(policyJson) ? { ...(policyJson as Record<string, unknown>) } : {};
	if (enabled) delete base.planMode;
	else base.planMode = false;
	return base;
}
