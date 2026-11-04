import {
	claimDueReturn,
	claimSkillPendingIntent,
	closePendingConfirmCard,
	createAgentRun,
	dismissPendingQuestionnaireCard,
	getAgentRun,
	getSkillPendingIntent,
	markPendingLoginOutcome,
	markReturnRun,
	requestResumeAgentRun,
} from "@workspace/db";
import {
	OWNER_WAIT_CARD_DETAIL,
	PROACTIVE_NO_UPDATE_TOKEN,
	ownerWaitResultText,
	scheduledReturnPrompt,
	type OwnerWaitJobPayload,
	type OwnerWaitJobResult,
	type OwnerWaitTimeoutJobPayload,
	type ScheduledReturnJobPayload,
} from "@workspace/shared";

/**
 * Processador da fila `atlas-owner-wait` (motor v3, PR8a). Os dois jobs são atrasados (sem varredura) e conferem o
 * estado no banco antes de agir: o dono que respondeu antes, o retorno cancelado ou o run que já seguiu viram no-op.
 * Prazo vencido NUNCA aprova: fecha o cartão como "Tempo esgotado · segui sem isso" e a continuação recebe "skipped".
 */
export type OwnerWaitProcessorDeps = {
	getAgentRun: typeof getAgentRun;
	getSkillPendingIntent: typeof getSkillPendingIntent;
	claimSkillPendingIntent: typeof claimSkillPendingIntent;
	closePendingConfirmCard: typeof closePendingConfirmCard;
	dismissPendingQuestionnaireCard: typeof dismissPendingQuestionnaireCard;
	markPendingLoginOutcome: typeof markPendingLoginOutcome;
	requestResumeAgentRun: typeof requestResumeAgentRun;
	createAgentRun: typeof createAgentRun;
	claimDueReturn: typeof claimDueReturn;
	markReturnRun: typeof markReturnRun;
	enqueueRun: (runId: string) => Promise<boolean>;
};

export const defaultOwnerWaitDeps = (enqueueRun: (runId: string) => Promise<boolean>): OwnerWaitProcessorDeps => ({
	getAgentRun,
	getSkillPendingIntent,
	claimSkillPendingIntent,
	closePendingConfirmCard,
	dismissPendingQuestionnaireCard,
	markPendingLoginOutcome,
	requestResumeAgentRun,
	createAgentRun,
	claimDueReturn,
	markReturnRun,
	enqueueRun,
});

/** Fala do run que continua depois do prazo (silenciosa: não vira mensagem do dono na conversa). */
export const TIMEOUT_TURN_NOTE = "[runtime] The owner did not answer in time. Continue the task without that step.";

/** Prefixo do pedido do retorno invisível: o worker não posta `[NO_UPDATE]` (como no run proativo). */
export const SILENT_RETURN_MARK = "[Scheduled return · silent]";

export function isSilentReturnObjective(objective: string | null | undefined): boolean {
	return (objective ?? "").startsWith(SILENT_RETURN_MARK);
}

async function continueAfterTimeout(job: OwnerWaitTimeoutJobPayload, deps: OwnerWaitProcessorDeps, seed: { toolName?: string; refused: string[] }): Promise<OwnerWaitJobResult> {
	const source = await deps.getAgentRun(job.runId);
	if (!source || source.userId !== job.userId || source.conversationId !== job.conversationId) return { outcome: "noop", detail: "source_run" };
	const resultContent = ownerWaitResultText("skipped_timeout", { what: job.what, minutes: job.minutes });
	const run = await deps.createAgentRun({
		request: {
			messages: [{ role: "user", content: TIMEOUT_TURN_NOTE }],
			conversationId: job.conversationId,
			...(source.botId ? { botId: source.botId } : {}),
			origin: "chat",
			silent: true,
			objective: TIMEOUT_TURN_NOTE,
			transcriptSeed: { fromRunId: job.runId, ...(seed.toolName ? { toolName: seed.toolName } : {}), resultContent, shortContent: TIMEOUT_TURN_NOTE, refused: seed.refused },
		},
		model: source.model,
		userId: job.userId,
		inheritFromRunId: job.runId,
	});
	// Conversa ocupada por outro run: o create devolve o ativo e a nota entra nele como entrada (o run não é nosso).
	if (run.id !== job.runId && run.status === "queued") await deps.enqueueRun(run.id);
	return { outcome: "resumed", runId: run.id };
}

export async function processCardTimeout(job: OwnerWaitTimeoutJobPayload, deps: OwnerWaitProcessorDeps): Promise<OwnerWaitJobResult> {
	if (job.card === "login") {
		// O run estacionado no login retoma ele mesmo (checkpoint), com a saída "skipped_timeout".
		const marked = await deps.markPendingLoginOutcome({ runId: job.runId, userId: job.userId, outcome: "skipped_timeout", loginId: job.cardId });
		if (!marked) return { outcome: "noop", detail: "login_answered" };
		const resumed = await deps.requestResumeAgentRun(job.runId);
		if (!resumed) return { outcome: "noop", detail: "not_paused" };
		await deps.enqueueRun(job.runId);
		return { outcome: "resumed", runId: job.runId };
	}
	if (job.card === "questionnaire") {
		const dismissed = await deps.dismissPendingQuestionnaireCard({ conversationId: job.conversationId, ownerId: job.userId, questionnaireId: job.cardId });
		if (!dismissed) return { outcome: "noop", detail: "answered" };
		return await continueAfterTimeout(job, deps, { toolName: job.toolName ?? "propose_questionnaire", refused: [`tool:${job.toolName ?? "propose_questionnaire"}`] });
	}
	const pending = await deps.getSkillPendingIntent(job.userId, job.conversationId);
	const intent = pending?.kind === "confirm" && pending.payload.action === "tool-call" && pending.payload.confirmId === job.cardId ? pending : null;
	// Só o cartão AINDA pendente fecha (o dono que respondeu antes ganha): nunca aprova por prazo.
	const closed = await deps.closePendingConfirmCard({ conversationId: job.conversationId, ownerId: job.userId, confirmId: job.cardId, status: "rejected", detail: OWNER_WAIT_CARD_DETAIL.skipped_timeout });
	if (!closed) return { outcome: "noop", detail: "answered" };
	if (intent) await deps.claimSkillPendingIntent(intent.id, job.userId, job.conversationId).catch(() => false);
	const callKey = intent?.payload.toolCall?.callKey ?? closed.callKey;
	const refused = [...(intent?.payload.toolCall?.refused ?? []), ...(callKey ? [`call:${callKey}`] : [])];
	return await continueAfterTimeout(job, deps, { ...(job.toolName ? { toolName: job.toolName } : {}), refused });
}

/**
 * Retorno agendado venceu: o run novo retoma a MESMA conversa com o contexto (transcript da conversa) e herda do run que
 * agendou o turno humano e o motor (sem humano, sem escrita). Origem sem humano vira run proativo (só leitura, silêncio).
 */
export async function processScheduledReturn(job: ScheduledReturnJobPayload, deps: OwnerWaitProcessorDeps): Promise<OwnerWaitJobResult> {
	const due = await deps.claimDueReturn(job.userId, job.returnId);
	if (!due) return { outcome: "noop", detail: "cancelled_or_fired" };
	const source = await deps.getAgentRun(due.sourceRunId);
	if (!source || source.userId !== job.userId) return { outcome: "noop", detail: "source_run" };
	const prompt = scheduledReturnPrompt({ reason: due.reason, visible: due.visible, scheduledAt: due.createdAt, noUpdateToken: PROACTIVE_NO_UPDATE_TOKEN });
	const content = due.visible ? prompt : `${SILENT_RETURN_MARK} ${prompt}`;
	const origin = source.origin === "chat" ? "chat" : "proactive";
	const run = await deps.createAgentRun({
		request: { messages: [{ role: "user", content }], conversationId: due.conversationId, ...(due.botId ? { botId: due.botId } : {}), origin, silent: true, objective: content },
		model: source.model,
		userId: job.userId,
		inheritFromRunId: due.sourceRunId,
	});
	await deps.markReturnRun(due.id, run.id).catch(() => undefined);
	if (run.status === "queued") await deps.enqueueRun(run.id);
	return { outcome: "resumed", runId: run.id };
}

export async function processOwnerWaitJob(payload: OwnerWaitJobPayload, deps: OwnerWaitProcessorDeps): Promise<OwnerWaitJobResult> {
	return payload.kind === "card_timeout" ? await processCardTimeout(payload, deps) : await processScheduledReturn(payload, deps);
}
