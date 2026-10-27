import { DAILY_BRIEF_TEMPLATE } from "@workspace/shared";
import { prisma } from "./client.js";

/**
 * Estado de entrega do brief "Seu dia" guardado em `RoutineRun.eventJson.briefDelivery` (coluna JSON que o
 * disparo por cron não usa; evita migration). `pending` = texto pronto que ainda não entrou no chat;
 * `posted` = já entrou. A virada pending -> posted é um UPDATE condicional (`claimBriefPosting`), então dois
 * caminhos (fim do run de chat, varredura de 60 s) nunca postam o mesmo brief duas vezes.
 */
type BriefDeliveryState = { state: "pending" | "posted"; text: string; at: string };

/** Brief mais antigo que isto não é mais postado (já não é "o seu dia" de hoje). */
const PENDING_MAX_AGE_MS = 12 * 60 * 60_000;

export type PendingBrief = { routineRunId: string; userId: string; botId: string; text: string };

function envelope(state: BriefDeliveryState["state"], text: string): { briefDelivery: BriefDeliveryState } {
	return { briefDelivery: { state, text, at: new Date().toISOString() } };
}

const stateFilter = (state: BriefDeliveryState["state"]) => ({ path: ["briefDelivery", "state"], equals: state });

/** Guarda o texto como pendente. Idempotente: não rebaixa um brief já postado. */
export async function markBriefPending(routineRunId: string, text: string): Promise<void> {
	await prisma.routineRun.updateMany({
		where: { id: routineRunId, NOT: { eventJson: stateFilter("posted") } },
		data: { eventJson: envelope("pending", text) },
	});
}

/** Reivindica a postagem: só uma chamada recebe `true` por brief. */
export async function claimBriefPosting(routineRunId: string, text: string): Promise<boolean> {
	const result = await prisma.routineRun.updateMany({
		where: { id: routineRunId, eventJson: stateFilter("pending") },
		data: { eventJson: envelope("posted", text) },
	});
	return result.count === 1;
}

/** A gravação da mensagem falhou depois de reivindicar: volta a pendente para a varredura tentar de novo. */
export async function releaseBriefPosting(routineRunId: string, text: string): Promise<void> {
	await prisma.routineRun.updateMany({
		where: { id: routineRunId, eventJson: stateFilter("posted") },
		data: { eventJson: envelope("pending", text) },
	});
}

/** Briefs prontos que ainda não entraram no chat (de qualquer dono; quem posta resolve a conversa pelo dono da rotina). */
export async function listPendingBriefs(now: Date = new Date(), limit = 20): Promise<PendingBrief[]> {
	const rows = await prisma.routineRun.findMany({
		where: {
			eventJson: stateFilter("pending"),
			createdAt: { gte: new Date(now.getTime() - PENDING_MAX_AGE_MS) },
			routine: { template: DAILY_BRIEF_TEMPLATE },
		},
		orderBy: { createdAt: "asc" },
		take: limit,
		select: { id: true, eventJson: true, routine: { select: { userId: true, botId: true } } },
	});
	const pending: PendingBrief[] = [];
	for (const row of rows) {
		const text = (row.eventJson as { briefDelivery?: { text?: unknown } } | null)?.briefDelivery?.text;
		if (typeof text !== "string" || !text.trim()) continue;
		pending.push({ routineRunId: row.id, userId: row.routine.userId, botId: row.routine.botId, text });
	}
	return pending;
}
