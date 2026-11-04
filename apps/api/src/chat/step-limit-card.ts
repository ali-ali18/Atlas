import { claimSkillPendingIntent, markPendingLimitOutcome, requestResumeAgentRun, updateConfirmCardStatus, type SkillPendingIntent } from "@workspace/db";
import type { AgentRun } from "@workspace/shared";

/**
 * Cartão "Cheguei no limite. Continuo?" do motor v3 (PR8b, decisão D4). O run sem humano parou no limite de passos ou de
 * US$ e está pausado com o checkpoint. O clique grava a decisão no checkpoint (escopado pelo dono) e só então libera o
 * MESMO run: Continuar segue com mais N passos; Agora não faz a resposta final contando o que ficou feito.
 */
export type StepLimitCardDeps = {
	claim: typeof claimSkillPendingIntent;
	markOutcome: typeof markPendingLimitOutcome;
	updateCard: typeof updateConfirmCardStatus;
	resume: typeof requestResumeAgentRun;
};

const DEFAULT_DEPS: StepLimitCardDeps = {
	claim: (...args) => claimSkillPendingIntent(...args),
	markOutcome: (...args) => markPendingLimitOutcome(...args),
	updateCard: (...args) => updateConfirmCardStatus(...args),
	resume: (...args) => requestResumeAgentRun(...args),
};

export const STEP_LIMIT_CARD_DETAIL = { continue: "o dono pediu para continuar", stop: "o dono encerrou no limite" } as const;

/**
 * `run`: o run retomado (quem chama põe na fila). `duplicate`: clique repetido, intenção vencida ou o run já não espera
 * este cartão: nada muda.
 */
export async function settleStepLimitCard(
	input: { userId: string; conversationId: string; pending: SkillPendingIntent; decision: "continue" | "stop" },
	deps: StepLimitCardDeps = DEFAULT_DEPS,
): Promise<{ run: AgentRun } | { duplicate: true }> {
	const runId = input.pending.payload.stepLimit?.runId;
	const cardId = input.pending.payload.confirmId;
	if (!runId || !cardId) return { duplicate: true };
	// Dois cliques ao mesmo tempo: só quem reserva a intenção decide.
	if (!(await deps.claim(input.pending.id, input.userId, input.conversationId))) return { duplicate: true };
	// A decisão vai ao checkpoint ANTES de liberar o run (o worker já acorda lendo-a). Só o run do dono que espera ESTE cartão.
	const marked = await deps.markOutcome({ runId, userId: input.userId, outcome: input.decision, cardId }).catch(() => false);
	await deps
		.updateCard(input.conversationId, input.decision === "continue" ? "approved" : "rejected", cardId, input.userId, { ok: input.decision === "continue", detail: STEP_LIMIT_CARD_DETAIL[input.decision] })
		.catch(() => undefined);
	if (!marked) return { duplicate: true };
	const run = await deps.resume(runId).catch(() => null);
	return run ? { run } : { duplicate: true };
}
