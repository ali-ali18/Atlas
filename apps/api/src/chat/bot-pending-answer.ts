import {
	buildQuestionnaireAnsweredMessages,
	buildQuestionnaireAnsweredObjective,
	devApprovalRejectText,
	labelCardProtocolMessage,
	needFromCardRow,
	parseConversationCard,
	questionnaireAnswerClientKey,
	questionnaireAnswerInstruction,
	serializeBotLinkCard,
	type CreateAgentRunRequest,
} from "@workspace/shared";
import {
	claimAutoDecision,
	createAgentRun,
	failAutoDecision,
	getAccountConfig,
	getSkillPendingIntent,
	listQueuedAutoDecisions,
	prisma,
	submitQuestionnaireCard,
} from "@workspace/db";
import { enqueueAgentRunJob } from "../routes/runs.js";
import type { RunQueue } from "../routes/run-queue.js";
import { peekModelContextLength } from "../routes/models.js";
import { applyConfirmedFollowUp, maybeHandleConfirmedAction } from "./confirmed-action.js";
import { resolveRunModel } from "./effective-model.js";

/**
 * Responde um card do bot de destino (relay para a conversa do orquestrador, ou
 * decisão automática dele). NÃO é um mecanismo paralelo de aprovação: monta o
 * mesmo texto-token do botão ("confirmado: …", "recusado: …", "cancela isso") e
 * passa por `maybeHandleConfirmedAction`, o mesmo caminho do clique na conversa do
 * destino; questionário usa `submitQuestionnaireCard` + run silencioso, como a rota
 * `/v1/questionnaire/submit`. Idempotente: card já resolvido = `already`.
 */
export type PendingAnswer =
	| { type: "approve" }
	| { type: "reject"; feedback?: string }
	| { type: "answer"; answers: Record<string, string | string[]> };

export type AnswerPendingResult =
	| { status: "applied"; runId?: string }
	| { status: "already" }
	| { status: "invalid"; error: string }
	| { status: "unavailable"; error: string };

export type AnswerPendingDeps = {
	queue: RunQueue | null;
	openRouterModel: string;
	getAccountConfig?: typeof getAccountConfig;
	/** Injetáveis em teste; padrão: db + fila. */
	createRun?: typeof createAgentRun;
	enqueue?: (queue: RunQueue, runId: string) => Promise<boolean>;
	resolveModel?: (botId: string, userId: string) => Promise<string>;
};

/** Uma resposta por vez por card neste processo (a checagem de "já resolvido" não é atômica no banco). */
const inFlight = new Set<string>();

export async function answerBotPending(
	input: { userId: string; conversationId: string; cardId: string; answer: PendingAnswer },
	deps: AnswerPendingDeps,
): Promise<AnswerPendingResult> {
	if (!deps.queue) return { status: "unavailable", error: "Agent run queue unavailable" };
	if (inFlight.has(input.cardId)) return { status: "already" };
	inFlight.add(input.cardId);
	try {
		return await apply(input, deps, deps.queue);
	} finally {
		inFlight.delete(input.cardId);
	}
}

async function apply(
	input: { userId: string; conversationId: string; cardId: string; answer: PendingAnswer },
	deps: AnswerPendingDeps,
	queue: RunQueue,
): Promise<AnswerPendingResult> {
	const { userId, conversationId } = input;
	const bot = await prisma.bot.findFirst({ where: { ownerId: userId, conversationId }, select: { id: true } });
	if (!bot) return { status: "invalid", error: "Bot not found" };
	const row = await prisma.conversationMessage.findUnique({ where: { id: input.cardId } });
	if (!row || row.conversationId !== conversationId) return { status: "invalid", error: "Card not found" };
	const intent = await getSkillPendingIntent(userId, conversationId).catch(() => null);
	const hint = intent?.kind === "confirm" ? intent.payload : null;
	const need = needFromCardRow({
		rowId: row.id,
		conversationId,
		role: row.role,
		content: row.content,
		intent: hint ? { action: hint.action, confirmId: hint.confirmId, actionClass: hint.mcpCall?.actionClass } : null,
	});
	if (!need) return { status: "already" };
	const card = parseConversationCard(row.content);
	const model = await (deps.resolveModel?.(bot.id, userId) ?? resolveRunModel({ botId: bot.id, userId, envDefault: deps.openRouterModel, getAccountConfig: deps.getAccountConfig }));

	if (card?.kind === "questionnaire") {
		if (input.answer.type !== "answer") return { status: "invalid", error: "Questionnaire needs answers" };
		const updated = await submitQuestionnaireCard(conversationId, card.questionnaireId, input.answer.answers);
		if (!updated) return { status: "already" };
		const answers = input.answer.answers;
		const request: CreateAgentRunRequest = {
			messages: buildQuestionnaireAnsweredMessages({
				systemInstruction: questionnaireAnswerInstruction({ purpose: updated.purpose, originalRequest: updated.originalRequest }),
				questionnaireId: card.questionnaireId,
				answers,
				submittedAt: new Date().toISOString(),
				purpose: updated.purpose ?? "task",
				originalRequest: updated.originalRequest,
			}),
			botId: bot.id,
			conversationId,
			origin: "chat",
			objective: buildQuestionnaireAnsweredObjective(card.questionnaireId, Object.keys(answers)),
			silent: true,
			clientKey: questionnaireAnswerClientKey(card.questionnaireId, answers).slice(0, 128),
		};
		return startRun(request, model, userId, queue, deps);
	}

	if (card?.kind !== "confirm" || input.answer.type === "answer") return { status: "invalid", error: "Card cannot be answered here" };
	// A intenção pendente expira (10 min) ou é trocada por um card mais novo: sem ela o clique não resolve este card.
	if (!hint || hint.confirmId !== card.confirmId) return { status: "already" };
	const text = input.answer.type === "approve"
			? `confirmado: ${card.title}`
			: input.answer.feedback && hint.action === "dev-command"
				? devApprovalRejectText(input.answer.feedback)
				: "cancela isso";
	let request: CreateAgentRunRequest = { messages: [{ role: "user", content: labelCardProtocolMessage(text) }], botId: bot.id, conversationId, origin: "chat" };
	const handled = await maybeHandleConfirmedAction({ text, userId, botId: bot.id, conversationId, model, continueInAgent: true });
	if (handled.handled) return { status: "applied", runId: handled.run.id };
	if (handled.followUp) {
		request = { ...request, messages: applyConfirmedFollowUp(request.messages, handled.followUp), objective: handled.followUp.objective, ...(handled.followUp.transcript ? { transcriptSeed: handled.followUp.transcript } : {}) };
	}
	return startRun(request, model, userId, queue, deps);
}

async function startRun(request: CreateAgentRunRequest, model: string, userId: string, queue: RunQueue, deps: AnswerPendingDeps): Promise<AnswerPendingResult> {
	const run = await (deps.createRun ?? createAgentRun)({ request, model, userId, contextLength: peekModelContextLength(model) });
	await (deps.enqueue ?? enqueueAgentRunJob)(queue, run.id);
	return { status: "applied", runId: run.id };
}

/**
 * Aplica as decisões automáticas do orquestrador (fila na conversa dele). Depois de
 * aplicar, reabre o pedido original para o resultado do destino voltar ao orquestrador
 * pela mesma entrega de respostas.
 */
export async function applyQueuedBotDecisions(deps: AnswerPendingDeps): Promise<number> {
	const queued = await listQueuedAutoDecisions();
	let applied = 0;
	for (const item of queued) {
		const card = await claimAutoDecision(item.rowId);
		if (!card) continue;
		const userId = item.userId ?? undefined;
		if (!userId) {
			await failAutoDecision(item.rowId);
			continue;
		}
		try {
			const answer: PendingAnswer =
				card.decision === "approved"
					? { type: "approve" }
					: card.decision === "rejected"
						? { type: "reject", feedback: card.feedback || card.reason }
						: { type: "answer", answers: card.answers ?? {} };
			const result = await answerBotPending({ userId, conversationId: card.need.conversationId, cardId: card.need.cardId, answer }, deps);
			if (result.status === "unavailable") {
				// Fila fora do ar: volta para a fila e tenta no próximo ciclo.
				await prisma.conversationMessage.update({ where: { id: item.rowId }, data: { content: serializeBotLinkCard({ ...card, status: "queued" }) } });
				continue;
			}
			if (result.status === "invalid") {
				await failAutoDecision(item.rowId);
				continue;
			}
			applied += 1;
			if (result.status === "applied" && result.runId) {
				await prisma.botMessage.updateMany({
					where: { id: card.botMessageId, userId, status: { in: ["closed", "replied", "reply_delivered"] } },
					data: { status: "delivered", toRunId: result.runId, replyContent: null, repliedAt: null, wakeRunId: null },
				});
			}
		} catch (error) {
			console.error("[bot-pending] apply auto decision failed", error);
			await failAutoDecision(item.rowId).catch(() => undefined);
		}
	}
	return applied;
}
