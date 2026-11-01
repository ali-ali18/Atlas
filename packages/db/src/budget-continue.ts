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
	isTaskListDone,
	parseBudgetContinueCard,
	parseTaskList,
	serializeConversationCard,
	withRunEngine,
	type PersistedBudgetContinueCard,
} from "@workspace/shared";
import { Prisma } from "@prisma/client";
import { prisma } from "./client.js";
import { getOwnedConversation } from "./conversations.js";
import { ACTIVE_STATUSES, ExclusiveRunConflictError, createAgentRun, readRunContextLength } from "./runs.js";

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
	| { ok: false; status: 404 | 409 | 410 | 503; error: string };

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

/** Oferta velha não gasta: vale por 24h e só a mais recente da conversa. */
export const BUDGET_CONTINUE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Lista de tarefas aberta do run que parou: a continuação a recebe pronta (como o caderno), sem depender da conversa. */
function openTaskState(checkpoint: Record<string, unknown>, objective: string): Record<string, unknown> | undefined {
	const list = parseTaskList((checkpoint.taskState as { taskList?: unknown } | undefined)?.taskList);
	if (!list || isTaskListDone(list)) return undefined;
	return {
		v: 1,
		objective: { text: objective.slice(0, 2_000), version: 1 },
		criteria: [],
		phase: "executing",
		blockers: [],
		artifacts: [],
		taskList: list,
	};
}

/** Run de continuação já criado para esta oferta (qualquer status): evita criar um segundo se algo falhou depois. */
async function findContinuationRun(userId: string, conversationId: string, offerId: string): Promise<string | null> {
	const rows = await prisma.agentRun.findMany({ where: { userId, conversationId, origin: "chat" }, orderBy: { createdAt: "desc" }, take: 20, select: { id: true, budgetJson: true, status: true } });
	return rows.find((row) => row.status !== "cancelled" && (row.budgetJson as { continuationOffer?: unknown } | null)?.continuationOffer === offerId)?.id ?? null;
}

/** Falhou depois do create: o run órfão (ainda na fila) é cancelado para a próxima tentativa não ter dois. */
async function cancelOrphanContinuation(userId: string, conversationId: string, offerId: string): Promise<void> {
	const id = await findContinuationRun(userId, conversationId, offerId);
	if (id) await prisma.agentRun.updateMany({ where: { id, userId, status: "queued" }, data: { status: "cancelled", finishedAt: new Date(), error: "cancelled" } });
}

export async function resolveBudgetContinue(
	input: { userId: string; conversationId: string; offerId: string; decision: "approved" | "dismissed"; now?: Date },
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

	// Oferta velha ou superada por outra mais nova não gasta: o card vira "Dispensado" e a resposta é amigável.
	const now = (input.now ?? new Date()).getTime();
	const newest = (await prisma.conversationMessage.findMany({ where: { conversationId: input.conversationId, role: "budget-continue" }, orderBy: { createdAt: "desc" }, take: 1 }))[0];
	const tooOld = now - new Date(row.createdAt as Date).getTime() > BUDGET_CONTINUE_MAX_AGE_MS;
	if (tooOld || (newest && newest.id !== row.id)) {
		await swapCard(row, { ...card, status: "dismissed" });
		return { ok: false, status: 410, error: "Esse pedido já passou. Se quiser continuar a pesquisa, peça de novo." };
	}

	// O run que parou precisa ser do dono e desta conversa; senão 404 (não revela que existe).
	const source = await prisma.agentRun.findFirst({
		where: { id: card.runId, userId: input.userId, conversationId: input.conversationId },
		select: { id: true, botId: true, model: true, objective: true, budgetJson: true, checkpointJson: true },
	});
	if (!source) return NOT_FOUND;

	// Já existe a continuação desta oferta (o card não chegou a gravar): reaproveita, nunca cria outra.
	const existingRun = await findContinuationRun(input.userId, input.conversationId, card.offerId);
	if (existingRun) {
		const done: PersistedBudgetContinueCard = { ...card, status: "approved", continuationRunId: existingRun };
		await swapCard(row, done);
		return { ok: true, card: done, unchanged: true };
	}

	// Um run por conversa: com outro em andamento a mensagem viraria entrada dele, não uma continuação.
	const active = await prisma.agentRun.findFirst({ where: { conversationId: input.conversationId, userId: input.userId, status: { in: ACTIVE_STATUSES } }, select: { id: true } });
	if (active) return { ok: false, status: 409, error: "Já há uma tarefa em andamento nesta conversa. Espere terminar e tente de novo." };

	const reserved: PersistedBudgetContinueCard = { ...card, status: "approved" };
	if (!(await swapCard(row, reserved))) return { ok: true, card: (await findOfferRow(input.conversationId, input.offerId))?.card ?? card, unchanged: true };

	try {
		const objective = `${originalRequest(source.objective)}\n\n${BUDGET_CONTINUE_INSTRUCTION}`.trim();
		const sourceCheckpoint = (source.checkpointJson ?? {}) as Record<string, unknown>;
		const taskState = openTaskState(sourceCheckpoint, objective);
		// Tudo no MESMO create: motor, perfil, origem, caderno e lista de tarefas (nada é sobrescrito depois).
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
			exclusive: {
				checkpoint: {
					...(Array.isArray(sourceCheckpoint.notebook) && sourceCheckpoint.notebook.length ? { notebook: sourceCheckpoint.notebook } : {}),
					...(taskState ? { taskState } : {}),
				},
				budget: { ...withRunEngine(null, { engine: "v2", profile: "long_work" }), continuationOf: source.id, continuationOffer: card.offerId },
			},
		});
		const done: PersistedBudgetContinueCard = { ...reserved, continuationRunId: run.id };
		// O run já existe: se só o card falhar em gravar, a próxima tentativa o reaproveita (findContinuationRun).
		await prisma.conversationMessage.updateMany({ where: { id: row.id }, data: { content: serializeConversationCard(done) } }).catch(() => undefined);
		return { ok: true, card: done, runId: run.id };
	} catch (error) {
		// Não saiu a continuação: cancela o que ficou pelo caminho e o card volta a pendente (nada foi gasto).
		await cancelOrphanContinuation(input.userId, input.conversationId, card.offerId).catch(() => undefined);
		await prisma.conversationMessage.updateMany({ where: { id: row.id }, data: { content: serializeConversationCard(card) } }).catch(() => undefined);
		if (error instanceof ExclusiveRunConflictError) return { ok: false, status: 409, error: "Já há uma tarefa em andamento nesta conversa. Espere terminar e tente de novo." };
		console.error("budget continue run failed", error instanceof Error ? error.message : "erro desconhecido");
		return { ok: false, status: 503, error: "Não consegui retomar agora. Tente de novo em instantes." };
	}
}

/** Card pendente da conversa do dono (a API confere o valor gravado). */
export async function getBudgetContinueOffer(userId: string, conversationId: string, offerId: string): Promise<PersistedBudgetContinueCard | null> {
	if (!(await getOwnedConversation(conversationId, userId))) return null;
	return (await findOfferRow(conversationId, offerId))?.card ?? null;
}
