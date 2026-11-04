import { dismissPendingQuestionnaireCard, findPendingQuestionnaireCard, getAgentRun } from "@workspace/db";
import { cancelOwnerWaitTimeout, cancelReturnJob, type OwnerWaitQueue } from "@workspace/queue";
import { ownerWaitResultText, readStoredRunEngine, type TranscriptSeed } from "@workspace/shared";

/**
 * "Esperar o dono" do motor v3 no lado da API (PR8a): cancelar o prazo de um cartão quando o dono responde antes,
 * cancelar um retorno agendado e transformar "o dono ignorou o cartão e mandou outra mensagem" na semente que o modelo
 * recebe. A fila é registrada uma vez no boot (`setOwnerWaitQueue`); sem Redis, cancelar é no-op e o job que escapar
 * confere o estado no banco antes de agir.
 */
let queue: OwnerWaitQueue | null = null;

export function setOwnerWaitQueue(next: OwnerWaitQueue | null): void {
	queue = next;
}

/** O dono respondeu (qualquer saída): o prazo daquele cartão não dispara mais. */
export async function cancelCardTimeout(cardId: string | undefined): Promise<void> {
	if (!queue || !cardId) return;
	await cancelOwnerWaitTimeout(queue, cardId).catch(() => false);
}

export async function cancelScheduledReturnJob(returnId: string): Promise<void> {
	if (!queue) return;
	await cancelReturnJob(queue, returnId).catch(() => false);
}

export const QUESTIONNAIRE_TOOL = "propose_questionnaire";
export const refusedQuestionnaireKey = `tool:${QUESTIONNAIRE_TOOL}`;

/** Run que mostrou o questionário (`questionnaire-<runId>`); `local`/vazio = sem run. */
export function questionnaireRunId(questionnaireId: string): string | undefined {
	const id = questionnaireId.startsWith("questionnaire-") ? questionnaireId.slice("questionnaire-".length) : "";
	return id && id !== "local" ? id : undefined;
}

/**
 * O dono mandou outra mensagem com um questionário do motor v3 ainda pendente: o cartão vira "Dispensado" e o run novo
 * parte da conversa do run que perguntou, com o resultado "owner did not answer the previous request and sent: …"
 * na chamada que parou. Só questionário de run v3 do mesmo dono; v1/v2 seguem como sempre (`null`).
 */
export async function ignoredQuestionnaireSeed(input: { userId: string; conversationId: string; text: string }): Promise<TranscriptSeed | null> {
	const card = await findPendingQuestionnaireCard(input.conversationId, input.userId).catch(() => null);
	const runId = card ? questionnaireRunId(card.questionnaireId) : undefined;
	if (!card || !runId) return null;
	const asking = await getAgentRun(runId).catch(() => null);
	if (!asking || asking.userId !== input.userId || asking.conversationId !== input.conversationId || readStoredRunEngine(asking.budgetJson) !== "v3") return null;
	const dismissed = await dismissPendingQuestionnaireCard({ conversationId: input.conversationId, ownerId: input.userId, questionnaireId: card.questionnaireId }).catch(() => null);
	if (!dismissed) return null;
	await cancelCardTimeout(card.questionnaireId);
	return {
		fromRunId: runId,
		toolName: QUESTIONNAIRE_TOOL,
		resultContent: ownerWaitResultText("ignored", { what: card.title, message: input.text }),
		shortContent: input.text,
		refused: [refusedQuestionnaireKey],
	};
}

/** "Pular" no questionário (v3): o modelo segue sem a resposta e não pergunta de novo neste trabalho. */
export function skippedQuestionnaireSeed(input: { questionnaireId: string; title: string }): TranscriptSeed | null {
	const runId = questionnaireRunId(input.questionnaireId);
	if (!runId) return null;
	const resultContent = ownerWaitResultText("skipped", { what: input.title });
	return { fromRunId: runId, toolName: QUESTIONNAIRE_TOOL, resultContent, shortContent: SKIPPED_TURN_NOTE, refused: [refusedQuestionnaireKey] };
}

export const SKIPPED_TURN_NOTE = "[runtime] The owner skipped your question. Continue the task without the answer.";
