import {
	findDuplicateRoutine,
	normalizeForDedupe,
	parseConversationCard,
	serializeConversationCard,
	type PersistedRoutineProposalCard,
	type RoutineProposalSpec,
	type RoutineRecord,
} from "@workspace/shared";
import { prisma } from "./client.js";
import { createRoutine, deleteRoutine, listRoutines } from "./routines.js";

/** Rótulo da mensagem de timeline (coluna `role`) do card de rotina proposta pelo bot. */
export const ROUTINE_PROPOSAL_ROLE = "routine-proposal";

/** Cria a rotina a partir da proposta, marcada como criada pelo bot. */
export async function createRoutineFromProposal(
	userId: string,
	botId: string,
	spec: RoutineProposalSpec,
): Promise<{ routine: RoutineRecord } | { duplicate: RoutineRecord }> {
	const existing = await listRoutines(userId, botId);
	const duplicate = findDuplicateRoutine(existing, { name: spec.name, prompt: spec.prompt, schedule: spec.schedule ?? null });
	if (duplicate) return { duplicate };
	const { routine } = await createRoutine(userId, {
		botId,
		name: spec.name,
		prompt: spec.prompt,
		createdBy: "bot",
		timezone: spec.timezone,
		enabled: true,
		...(spec.everyMinutes !== undefined
			? { triggerType: "interval" as const, trigger: { kind: "interval" as const, everyMinutes: spec.everyMinutes } }
			: { triggerType: "cron" as const, schedule: spec.schedule ?? null }),
	});
	return { routine };
}

/** Grava o card na conversa do bot e devolve o id da mensagem (o clique usa esse id). */
export async function appendRoutineProposalCard(
	conversationId: string,
	card: PersistedRoutineProposalCard,
): Promise<string> {
	const row = await prisma.conversationMessage.create({
		data: { conversationId, role: ROUTINE_PROPOSAL_ROLE, content: serializeConversationCard(card) },
		select: { id: true },
	});
	return row.id;
}

export type ProposalDecision = "accept" | "decline";

export type ProposalResolution =
	| {
			ok: true;
			card: PersistedRoutineProposalCard;
			/** Rotina criada agora (o chamador sincroniza o agendador). */
			created?: RoutineRecord;
			/** Rotina removida agora (o chamador tira do agendador). */
			deletedRoutineId?: string;
			/** O card já estava resolvido: nada mudou. */
			unchanged?: boolean;
	  }
	| { ok: false; status: 404 | 409 | 500; error: string };

async function loadOwnedProposal(userId: string, messageId: string) {
	if (!userId.trim() || userId === "default") return null;
	const row = await prisma.conversationMessage.findFirst({
		where: {
			id: messageId,
			role: ROUTINE_PROPOSAL_ROLE,
			conversation: { is: { userId } },
		},
		select: { id: true, content: true, conversationId: true },
	});
	if (!row) return null;
	// Conversa de bot do dono (nunca a de outro usuário nem de grupo alheio).
	const bot = await prisma.bot.findFirst({
		where: { conversationId: row.conversationId, ownerId: userId },
		select: { id: true, isPrimary: true },
	});
	if (!bot) return null;
	const card = parseConversationCard(row.content);
	if (!card || card.kind !== "routine-proposal") return null;
	return { row, card, botId: bot.id };
}

/** Troca o conteúdo só se ninguém mexeu antes (dois cliques seguidos não criam duas rotinas). */
async function swapCard(
	row: { id: string; content: string },
	next: PersistedRoutineProposalCard,
): Promise<boolean> {
	const result = await prisma.conversationMessage.updateMany({
		where: { id: row.id, content: row.content },
		data: { content: serializeConversationCard(next) },
	});
	return result.count === 1;
}

/**
 * Resolve o clique do card.
 *  - Sugerir + accept: cria a rotina (criada pelo bot) e marca `accepted`.
 *  - Sugerir + decline: marca `declined`.
 *  - Automático + accept ("Manter"): marca `accepted`.
 *  - Automático + decline ("Desfazer"): apaga a rotina e marca `declined`.
 */
export async function resolveRoutineProposal(input: {
	userId: string;
	messageId: string;
	decision: ProposalDecision;
}): Promise<ProposalResolution> {
	const found = await loadOwnedProposal(input.userId, input.messageId);
	if (!found) return { ok: false, status: 404, error: "Proposta não encontrada" };
	const { row, card, botId } = found;
	if (card.status !== "pending") return { ok: true, card, unchanged: true };

	if (input.decision === "decline") {
		const next: PersistedRoutineProposalCard = { ...card, status: "declined" };
		if (!(await swapCard(row, next))) return { ok: true, card, unchanged: true };
		let deletedRoutineId: string | undefined;
		if (card.mode === "auto" && card.routineId) {
			const deleted = await deleteRoutine(input.userId, botId, card.routineId).catch(() => false);
			if (deleted) deletedRoutineId = card.routineId;
		}
		return { ok: true, card: next, ...(deletedRoutineId ? { deletedRoutineId } : {}) };
	}

	if (card.mode === "auto") {
		const next: PersistedRoutineProposalCard = { ...card, status: "accepted" };
		if (!(await swapCard(row, next))) return { ok: true, card, unchanged: true };
		return { ok: true, card: next };
	}

	// Sugerir + Criar: reserva o card primeiro e só então cria (clique duplo não duplica).
	const reserved: PersistedRoutineProposalCard = { ...card, status: "accepted" };
	if (!(await swapCard(row, reserved))) return { ok: true, card, unchanged: true };
	try {
		const outcome = await createRoutineFromProposal(input.userId, botId, card.spec);
		if ("duplicate" in outcome) {
			const next: PersistedRoutineProposalCard = { ...reserved, routineId: outcome.duplicate.id };
			await prisma.conversationMessage.update({ where: { id: row.id }, data: { content: serializeConversationCard(next) } });
			return { ok: true, card: next };
		}
		const next: PersistedRoutineProposalCard = { ...reserved, routineId: outcome.routine.id };
		await prisma.conversationMessage.update({ where: { id: row.id }, data: { content: serializeConversationCard(next) } });
		return { ok: true, card: next, created: outcome.routine };
	} catch (error) {
		// Volta a pendente para o usuário tentar de novo.
		await prisma.conversationMessage
			.update({ where: { id: row.id }, data: { content: serializeConversationCard(card) } })
			.catch(() => undefined);
		return { ok: false, status: 500, error: error instanceof Error ? error.message : "Não consegui criar a rotina" };
	}
}

/** Proposta anterior com o mesmo nome (qualquer estado): "Agora não" não volta a perguntar a mesma coisa. */
export async function findRecentProposalByName(
	conversationId: string,
	name: string,
): Promise<PersistedRoutineProposalCard | null> {
	const rows = await prisma.conversationMessage.findMany({
		where: { conversationId, role: ROUTINE_PROPOSAL_ROLE },
		orderBy: { createdAt: "desc" },
		take: 60,
		select: { content: true },
	});
	const wanted = normalizeForDedupe(name);
	for (const row of rows) {
		const card = parseConversationCard(row.content);
		if (card?.kind === "routine-proposal" && normalizeForDedupe(card.spec.name) === wanted) return card;
	}
	return null;
}
