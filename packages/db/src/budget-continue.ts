/**
 * "Continuar pesquisa (+US$ X)": oferta e aprovação (dinheiro é decisão da pessoa).
 *
 * - `offerBudgetContinue` (worker, fim do run): grava o card na conversa do dono, uma vez por run (id estável).
 * - `resolveBudgetContinue` (API): o que vale é o card GRAVADO (valor e run de origem), nunca o corpo do pedido.
 *   Aprovar reserva o card por troca condicional (toque duplo cria um run só), cria o run de continuação com teto de
 *   custo igual ao do card, copia o caderno do run que parou (mesmo dono) e marca motor/perfil, para a continuação
 *   retomar o trabalho sem refazer o que já foi feito. Recusar só marca o card. Sem aprovação nada é gasto.
 * - Conversa, card ou run de outro dono = 404.
 */
import {
	BUDGET_CONTINUE_INSTRUCTION,
	buildBudgetContinueCard,
	parseBudgetContinueCard,
	serializeConversationCard,
	withRunEngine,
	type PersistedBudgetContinueCard,
} from "@workspace/shared";
import { Prisma } from "@prisma/client";
import { prisma } from "./client.js";
import { getOwnedConversation } from "./conversations.js";
import { ACTIVE_STATUSES, createAgentRun, readRunContextLength } from "./runs.js";

export type BudgetContinueDeps = {
	createRun: typeof createAgentRun;
};

const defaultDeps: BudgetContinueDeps = { createRun: createAgentRun };

export type BudgetContinueResolution =
	| {
			ok: true;
			card: PersistedBudgetContinueCard;
			/** O card já estava decidido: nada mudou (toque duplo). */
			unchanged?: boolean;
			/** Run de continuação criado agora (a API o enfileira). */
			runId?: string;
	  }
	| { ok: false; status: 404 | 409 | 503; error: string };

const NOT_FOUND = { ok: false, status: 404, error: "Pedido não encontrado." } as const;

function parseCard(content: string): PersistedBudgetContinueCard | null {
	try {
		return parseBudgetContinueCard(JSON.parse(content));
	} catch {
		return null;
	}
}

async function findOfferRow(conversationId: string, offerId: string) {
	const rows = await prisma.conversationMessage.findMany({
		where: { conversationId, role: "budget-continue" },
		orderBy: { createdAt: "desc" },
		take: 20,
	});
	for (const row of rows) {
		const card = parseCard(row.content);
		if (card && card.offerId === offerId) return { row, card };
	}
	return null;
}

/** Troca o conteúdo só se ninguém mexeu antes (dois cliques seguidos não criam dois runs). */
async function swapCard(row: { id: string; content: string }, next: PersistedBudgetContinueCard): Promise<boolean> {
	const result = await prisma.conversationMessage.updateMany({
		where: { id: row.id, content: row.content },
		data: { content: serializeConversationCard(next) },
	});
	return result.count === 1;
}

/** Grava o card (uma vez por run que parou). `null` = conversa de outro dono, valor inválido ou já existia. */
export async function offerBudgetContinue(input: {
	userId: string;
	conversationId: string;
	runId: string;
	budgetUsd: number;
}): Promise<PersistedBudgetContinueCard | null> {
	if (!input.userId.trim() || input.userId === "default") return null;
	const card = buildBudgetContinueCard({ runId: input.runId, budgetUsd: input.budgetUsd });
	if (!card) return null;
	if (!(await getOwnedConversation(input.conversationId, input.userId))) return null;
	if (await findOfferRow(input.conversationId, card.offerId)) return null;
	await prisma.conversationMessage.create({
		data: { conversationId: input.conversationId, role: "budget-continue", content: serializeConversationCard(card), runId: input.runId },
	});
	return card;
}

/** O pedido original de quem pediu o trabalho, sem repetir a instrução de continuar (continuação de continuação). */
function originalRequest(objective: string): string {
	return objective.split(BUDGET_CONTINUE_INSTRUCTION).join("").trim().slice(0, 4_000);
}

export async function resolveBudgetContinue(
	input: { userId: string; conversationId: string; offerId: string; decision: "approved" | "dismissed" },
	deps: BudgetContinueDeps = defaultDeps,
): Promise<BudgetContinueResolution> {
	if (!input.userId.trim() || input.userId === "default") return NOT_FOUND;
	if (!(await getOwnedConversation(input.conversationId, input.userId))) return NOT_FOUND;
	const found = await findOfferRow(input.conversationId, input.offerId);
	if (!found) return NOT_FOUND;
	const { row, card } = found;

	if (card.status !== "pending") {
		if (card.status === "dismissed" && input.decision === "approved") return { ok: false, status: 409, error: "Este pedido já foi dispensado." };
		return { ok: true, card, unchanged: true };
	}

	if (input.decision === "dismissed") {
		const next: PersistedBudgetContinueCard = { ...card, status: "dismissed" };
		if (!(await swapCard(row, next))) return { ok: true, card: (await findOfferRow(input.conversationId, input.offerId))?.card ?? card, unchanged: true };
		return { ok: true, card: next };
	}

	// O run que parou precisa ser do dono e desta conversa; senão 404 (não revela que existe).
	const source = await prisma.agentRun.findFirst({
		where: { id: card.runId, userId: input.userId, conversationId: input.conversationId },
		select: { id: true, botId: true, model: true, objective: true, budgetJson: true, checkpointJson: true },
	});
	if (!source) return NOT_FOUND;
	// Um run por conversa: com outro em andamento a mensagem viraria entrada dele, não uma continuação.
	const active = await prisma.agentRun.findFirst({ where: { conversationId: input.conversationId, userId: input.userId, status: { in: ACTIVE_STATUSES } }, select: { id: true } });
	if (active) return { ok: false, status: 409, error: "Já há uma tarefa em andamento nesta conversa. Espere terminar e tente de novo." };

	const reserved: PersistedBudgetContinueCard = { ...card, status: "approved" };
	if (!(await swapCard(row, reserved))) return { ok: true, card: (await findOfferRow(input.conversationId, input.offerId))?.card ?? card, unchanged: true };

	try {
		const objective = `${originalRequest(source.objective)}\n\n${BUDGET_CONTINUE_INSTRUCTION}`.trim();
		const run = await deps.createRun({
			request: {
				messages: [{ role: "user", content: objective }],
				conversationId: input.conversationId,
				...(source.botId ? { botId: source.botId } : {}),
				origin: "chat",
				objective,
				// A pessoa já aprovou pelo card: nada de mensagem nova no chat.
				silent: true,
				clientKey: `budget-continue:${card.offerId}`.slice(0, 128),
				budget: { maxCostUsd: card.budgetUsd },
			},
			model: source.model,
			userId: input.userId,
			contextLength: readRunContextLength({ budgetJson: source.budgetJson }),
		});
		// Mesmo motor e perfil do run que parou (a retomada nunca troca) e o caderno dele, para não refazer a pesquisa.
		const checkpoint = (source.checkpointJson ?? {}) as { notebook?: unknown };
		const target = await prisma.agentRun.findFirst({ where: { id: run.id, userId: input.userId }, select: { checkpointJson: true, budgetJson: true } });
		if (target) {
			const nextCheckpoint = { ...((target.checkpointJson ?? {}) as Record<string, unknown>), ...(Array.isArray(checkpoint.notebook) && checkpoint.notebook.length ? { notebook: checkpoint.notebook } : {}) };
			const nextBudget = { ...withRunEngine(target.budgetJson, { engine: "v2", profile: "long_work" }), continuationOf: source.id };
			await prisma.agentRun.updateMany({
				where: { id: run.id, userId: input.userId },
				data: { checkpointJson: nextCheckpoint as Prisma.InputJsonValue, budgetJson: nextBudget as Prisma.InputJsonValue },
			});
		}
		const done: PersistedBudgetContinueCard = { ...reserved, continuationRunId: run.id };
		await prisma.conversationMessage.updateMany({ where: { id: row.id }, data: { content: serializeConversationCard(done) } });
		return { ok: true, card: done, runId: run.id };
	} catch (error) {
		// Não saiu o run: o card volta a pendente para a pessoa tentar de novo (nada foi gasto).
		await prisma.conversationMessage.updateMany({ where: { id: row.id }, data: { content: serializeConversationCard(card) } }).catch(() => undefined);
		console.error("budget continue run failed", error instanceof Error ? error.message : "erro desconhecido");
		return { ok: false, status: 503, error: "Não consegui retomar agora. Tente de novo em instantes." };
	}
}

/** Card pendente da conversa do dono (a API confere o valor gravado). */
export async function getBudgetContinueOffer(userId: string, conversationId: string, offerId: string): Promise<PersistedBudgetContinueCard | null> {
	if (!(await getOwnedConversation(conversationId, userId))) return null;
	return (await findOfferRow(conversationId, offerId))?.card ?? null;
}
