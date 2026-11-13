/**
 * Evento que chegou com o item de intenção ocupado (run em andamento, reserva ativa ou acordou há pouco) não se perde
 * (auditoria F4, B5): o item é marcado como "evento pendente" e a varredura o acorda de novo assim que o run atual terminar,
 * respeitando o espaçamento mínimo entre acordares. O run lê a caixa de entrada, então a marca não precisa guardar o evento.
 *
 * A marca é `endReason = "event_pending"` num item `pending` (a coluna só tem sentido em item encerrado; `stopAgendaItem`
 * a sobrescreve e retomar zera). Não usa `dueAt` porque o fechamento do run o refaz (em `intent` volta para o fim da vigência).
 * Tudo filtra pelo dono; a reserva usa `FOR UPDATE SKIP LOCKED` como a do `claimDueAgendaItems`.
 */
import { AGENDA_EVENT_PENDING, getAgendaItem, markAgendaEventPending, prisma, type AgendaItemRecord } from "@workspace/db";
import { AGENDA_EVENT_MAX_WAKES_PER_DAY } from "@workspace/shared";

export const EVENT_PENDING = AGENDA_EVENT_PENDING;
const CLAIM_MS = 2 * 60_000;
const BATCH = 20;

/** Marca o item de intenção do dono como "tem evento esperando". `false` = não era item `intent` pendente dele. */
export async function markPendingEvent(userId: string, id: string): Promise<boolean> {
	return markAgendaEventPending(userId, id);
}

/** O run do item começou (ou o item voltou ao normal): tira a marca. */
export async function clearPendingEvent(userId: string, id: string): Promise<void> {
	await prisma.botFollowup.updateMany({ where: { id, userId, agendaKind: "intent", status: "pending", endReason: EVENT_PENDING }, data: { endReason: null } });
}

/**
 * Reserva os itens com evento pendente cujo run anterior terminou e que já passaram do espaçamento mínimo. Respeita o teto
 * diário da intenção (reauditoria F4, N1): com a janela de 24h cheia o item continua marcado (o evento não se perde) e só
 * é reservado quando a janela vira, a mesma regra de `planAgendaEventWake`.
 */
export async function claimPendingEventItems(now: Date, minGapMinutes: number, limit = BATCH): Promise<AgendaItemRecord[]> {
	const claimUntil = new Date(now.getTime() + CLAIM_MS);
	const gapCutoff = new Date(now.getTime() - minGapMinutes * 60_000);
	const windowCutoff = new Date(now.getTime() - 24 * 60 * 60_000);
	const rows = await prisma.$queryRaw<Array<{ id: string; userId: string }>>`
		UPDATE "bot_followups" SET "claimedUntil" = ${claimUntil}, "updatedAt" = ${now}
		WHERE "id" IN (
			SELECT "id" FROM "bot_followups"
			WHERE "status" = 'pending' AND "agendaKind" = 'intent' AND "endReason" = ${EVENT_PENDING}
			  AND ("claimedUntil" IS NULL OR "claimedUntil" <= ${now})
			  AND ("eventWindowAt" IS NULL OR "eventWindowAt" <= ${windowCutoff} OR "eventWindowCount" < ${AGENDA_EVENT_MAX_WAKES_PER_DAY})
			  AND ("lastResultJson" IS NULL OR ("lastResultJson"->>'at')::timestamptz <= ${gapCutoff})
			ORDER BY "updatedAt" ASC
			LIMIT ${limit}
			FOR UPDATE SKIP LOCKED
		)
		RETURNING "id", "userId"`;
	const items = await Promise.all(rows.map((row) => getAgendaItem(row.userId, row.id)));
	return items.flatMap((item) => (item ? [item] : []));
}
