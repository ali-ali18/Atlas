import {
	DELIVERY_MAX_ATTEMPTS,
	planDeliveryDue,
	type DeliveryOutcome,
	type DueDelivery,
} from "@workspace/shared";
import { prisma } from "./client.js";

/**
 * Backlog de entrega offline (F5). Toda função que lê ou escreve recebe o `userId`
 * dono do run/conversa; só as do sweeper do worker (`claimDueDeliveries`,
 * `settleSeenDeliveries`, `recoverStuckDeliveries`) varrem todos os usuários e
 * devolvem sempre o `userId` junto, para o lote nunca misturar donos.
 */

const UNREAD_STATUSES = ["ready", "sending", "sent"];
/** `sending` que ficou preso (worker caiu no meio) volta para a fila depois disto. */
const STUCK_SENDING_MS = 10 * 60 * 1000;

/** Nota de ausência: o usuário avisou que sai. Só vale para run do próprio usuário. */
export async function recordAwayNote(input: {
	userId: string;
	runId: string;
	conversationId: string;
	deliverAfter?: Date | null;
}): Promise<boolean> {
	const run = await prisma.agentRun.findFirst({
		where: { id: input.runId, userId: input.userId },
		select: { id: true },
	});
	if (!run) return false;
	const existing = await prisma.runDelivery.findUnique({ where: { runId: input.runId } });
	if (existing) {
		// Nota nova com horário substitui o antigo; sem horário não apaga o combinado.
		if (input.deliverAfter && existing.status === "waiting") {
			await prisma.runDelivery.updateMany({
				where: { id: existing.id as string, userId: input.userId, status: "waiting" },
				data: { deliverAfter: input.deliverAfter },
			});
		}
		return true;
	}
	await prisma.runDelivery.create({
		data: {
			userId: input.userId,
			runId: input.runId,
			conversationId: input.conversationId,
			status: "waiting",
			deliverAfter: input.deliverAfter ?? null,
		},
	});
	return true;
}

/** O run terminou: se havia nota de ausência, o resultado entra no backlog. */
export async function markDeliveryReady(input: {
	userId: string;
	runId: string;
	outcome: DeliveryOutcome;
	summary: string;
	now?: Date;
}): Promise<boolean> {
	const row = await prisma.runDelivery.findFirst({ where: { runId: input.runId, userId: input.userId } });
	if (!row || row.status !== "waiting") return false;
	const now = input.now ?? new Date();
	const result = await prisma.runDelivery.updateMany({
		where: { id: row.id as string, userId: input.userId, status: "waiting" },
		data: {
			status: "ready",
			outcome: input.outcome,
			summary: input.summary,
			dueAt: planDeliveryDue({ completedAt: now, deliverAfter: (row.deliverAfter as Date | null) ?? null }),
		},
	});
	return result.count > 0;
}

/** Run cancelado pelo usuário: nada a entregar. */
export async function cancelRunDelivery(input: { userId: string; runId: string }): Promise<void> {
	await prisma.runDelivery.updateMany({
		where: { runId: input.runId, userId: input.userId, status: "waiting" },
		data: { status: "cancelled" },
	});
}

/** O usuário abriu a conversa: o resultado foi visto (apaga o badge e cancela a notificação pendente). */
export async function markConversationResultsSeen(input: {
	userId: string;
	conversationId: string;
	now?: Date;
}): Promise<number> {
	const result = await prisma.runDelivery.updateMany({
		where: { userId: input.userId, conversationId: input.conversationId, seenAt: null },
		data: { seenAt: input.now ?? new Date() },
	});
	return result.count;
}

/** Quantos resultados novos (ainda não vistos) cada conversa do usuário tem. */
export async function unreadResultsByConversation(userId: string): Promise<Map<string, number>> {
	const rows = await prisma.runDelivery.findMany({
		where: { userId, seenAt: null, status: { in: UNREAD_STATUSES } },
		select: { conversationId: true },
	});
	const counts = new Map<string, number>();
	for (const row of rows) {
		const id = row.conversationId as string;
		counts.set(id, (counts.get(id) ?? 0) + 1);
	}
	return counts;
}

/** Visto antes do horário da notificação: dispensa o envio. */
export async function settleSeenDeliveries(): Promise<number> {
	const result = await prisma.runDelivery.updateMany({
		where: { status: "ready", seenAt: { not: null } },
		data: { status: "cancelled" },
	});
	return result.count;
}

export async function recoverStuckDeliveries(now: Date = new Date()): Promise<number> {
	const result = await prisma.runDelivery.updateMany({
		where: { status: "sending", updatedAt: { lt: new Date(now.getTime() - STUCK_SENDING_MS) } },
		data: { status: "ready" },
	});
	return result.count;
}

/** Reivindica as entregas vencidas (uma a uma, `ready` → `sending`): outro sweeper não repete. */
export async function claimDueDeliveries(now: Date = new Date(), limit = 100): Promise<DueDelivery[]> {
	const due = await prisma.runDelivery.findMany({
		where: { status: "ready", seenAt: null, dueAt: { lte: now } },
		orderBy: { dueAt: "asc" },
		take: limit,
	});
	const claimed: DueDelivery[] = [];
	for (const row of due) {
		const won = await prisma.runDelivery.updateMany({
			where: { id: row.id as string, status: "ready", seenAt: null },
			data: { status: "sending" },
		});
		if (won.count === 0) continue;
		claimed.push({
			id: row.id as string,
			userId: row.userId as string,
			conversationId: row.conversationId as string,
			botName: null,
			outcome: ((row.outcome as string | null) ?? "completed") as DeliveryOutcome,
			summary: (row.summary as string | null) ?? "",
		});
	}
	if (claimed.length === 0) return claimed;
	const bots = await prisma.bot.findMany({
		where: { conversationId: { in: claimed.map((item) => item.conversationId) } },
		select: { conversationId: true, ownerId: true, name: true },
	});
	for (const item of claimed) {
		// Só o bot do próprio dono da entrega dá nome ao item.
		const bot = bots.find(
			(candidate) => candidate.conversationId === item.conversationId && candidate.ownerId === item.userId,
		);
		item.botName = bot?.name ?? null;
	}
	return claimed;
}

/** Resultado do envio: `sent` ou volta à fila (com teto de tentativas). */
export async function finishDeliveries(ids: string[], ok: boolean, now: Date = new Date()): Promise<void> {
	if (ids.length === 0) return;
	if (ok) {
		await prisma.runDelivery.updateMany({
			where: { id: { in: ids }, status: "sending" },
			data: { status: "sent", notifiedAt: now },
		});
		return;
	}
	await prisma.runDelivery.updateMany({
		where: { id: { in: ids }, status: "sending" },
		data: { status: "ready", attempts: { increment: 1 } },
	});
	await prisma.runDelivery.updateMany({
		where: { id: { in: ids }, status: "ready", attempts: { gte: DELIVERY_MAX_ATTEMPTS } },
		data: { status: "failed" },
	});
}

export async function getUserEmail(userId: string): Promise<string | null> {
	const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
	return user?.email?.trim() || null;
}
