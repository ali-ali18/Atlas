import {
	EMPTY_UNREAD,
	advanceLastReadAt,
	initialLastReadAt,
	type ConversationUnread,
} from "@workspace/shared";
import { prisma } from "./client.js";
import { markConversationResultsSeen } from "./deliveries.js";

/**
 * Estado de leitura por (usuário, conversa). Toda função recebe o `userId` dono
 * e só toca linhas dele; quem chama já validou a posse da conversa.
 */

const MIGRATION_NAME = "20261028120000_conversation_reads";
let migratedAtCache: Date | null | undefined;

/** Quando a migration de leitura rodou (lida uma vez de _prisma_migrations); null se não der para saber. */
async function readStateMigratedAt(): Promise<Date | null> {
	if (migratedAtCache !== undefined) return migratedAtCache;
	try {
		const rows = await prisma.$queryRaw<Array<{ finished_at: Date | null }>>`SELECT finished_at FROM _prisma_migrations WHERE migration_name = ${MIGRATION_NAME} LIMIT 1`;
		migratedAtCache = rows[0]?.finished_at ?? null;
	} catch {
		migratedAtCache = null;
	}
	return migratedAtCache;
}

/** Só para testes. */
export function setReadStateMigratedAtForTests(value: Date | null | undefined): void {
	migratedAtCache = value;
}

/** Estado de leitura de várias conversas. Conversa sem linha é inicializada (histórico antigo conta como lido). */
export async function getUnreadStates(
	userId: string,
	conversationIds: string[],
	now: Date = new Date(),
): Promise<Map<string, ConversationUnread>> {
	const result = new Map<string, ConversationUnread>();
	const ids = [...new Set(conversationIds.filter(Boolean))];
	if (ids.length === 0) return result;
	const rows = await prisma.conversationRead.findMany({ where: { userId, conversationId: { in: ids } } });
	const reads = new Map(
		rows.map((row) => [
			row.conversationId as string,
			{
				lastReadAt: row.lastReadAt as Date,
				manualUnread: row.manualUnread as boolean,
				lastReadMessageId: (row.lastReadMessageId as string | null) ?? null,
			},
		]),
	);
	const missing = ids.filter((id) => !reads.has(id));
	if (missing.length > 0) {
		const migratedAt = await readStateMigratedAt();
		const conversations = await prisma.conversation.findMany({
			where: { id: { in: missing }, userId },
			select: { id: true, createdAt: true },
		});
		const created = conversations.map((conversation) => ({
			userId,
			conversationId: conversation.id as string,
			lastReadAt: initialLastReadAt(conversation.createdAt as Date, now, migratedAt),
			manualUnread: false,
		}));
		if (created.length > 0) {
			// Uma inserção só; `skipDuplicates` cobre a corrida com outra requisição que criou primeiro.
			await prisma.conversationRead.createMany({ data: created, skipDuplicates: true }).catch(() => undefined);
		}
		for (const row of created) reads.set(row.conversationId, { lastReadAt: row.lastReadAt, manualUnread: false, lastReadMessageId: null });
	}
	// Contagem no banco (antes: até 5000 mensagens trazidas e contadas em JS, o que errava passando disso).
	// Subconsultas correlacionadas usam o índice (conversationId, createdAt); a regra é a de `computeUnread`:
	// só fala do assistente depois de lastReadAt, e a primeira não lida é a mais antiga (createdAt, id).
	const readIds = [...reads.keys()];
	const counts = readIds.length === 0 ? [] : await prisma.$queryRaw<Array<{ conversationId: string; unreadCount: number; firstUnreadMessageId: string | null }>>`
		SELECT r."conversationId",
			(SELECT COUNT(*)::int FROM "conversation_messages" m
				WHERE m."conversationId" = r."conversationId" AND m."role" = 'assistant' AND m."createdAt" > r."lastReadAt") AS "unreadCount",
			(SELECT m."id" FROM "conversation_messages" m
				WHERE m."conversationId" = r."conversationId" AND m."role" = 'assistant' AND m."createdAt" > r."lastReadAt"
				ORDER BY m."createdAt" ASC, m."id" ASC LIMIT 1) AS "firstUnreadMessageId"
		FROM "conversation_reads" r
		WHERE r."userId" = ${userId} AND r."conversationId" = ANY(${readIds}::text[])
	`;
	const countByConversation = new Map(counts.map((row) => [row.conversationId, row]));
	for (const id of ids) {
		const read = reads.get(id);
		if (!read) {
			result.set(id, EMPTY_UNREAD);
			continue;
		}
		const row = countByConversation.get(id);
		result.set(id, {
			unreadCount: row?.unreadCount ?? 0,
			firstUnreadMessageId: row?.firstUnreadMessageId ?? null,
			manualUnread: read.manualUnread,
		});
	}
	return result;
}

export async function getUnreadState(userId: string, conversationId: string): Promise<ConversationUnread> {
	return (await getUnreadStates(userId, [conversationId])).get(conversationId) ?? EMPTY_UNREAD;
}

/**
 * Marca como lida até uma mensagem ou instante. Monotônico: nunca volta para trás.
 * Sem alvo, vale "agora". Limpa o "não lida" manual.
 */
export async function markConversationRead(input: {
	userId: string;
	conversationId: string;
	upToMessageId?: string | null;
	upToAt?: Date | null;
	now?: Date;
}): Promise<ConversationUnread | null> {
	const now = input.now ?? new Date();
	let target = input.upToAt ?? now;
	let messageId: string | null = null;
	if (input.upToMessageId) {
		const message = await prisma.conversationMessage.findFirst({
			where: { id: input.upToMessageId, conversationId: input.conversationId },
			select: { id: true, createdAt: true },
		});
		if (!message) return null;
		target = message.createdAt as Date;
		messageId = message.id as string;
	}
	// Nunca no futuro: um relógio errado no cliente não pode "ler" mensagens que ainda não existem.
	if (target.getTime() > now.getTime()) target = now;
	const where = { userId: input.userId, conversationId: input.conversationId };
	// Avanço atômico e monotônico: dois aparelhos lendo ao mesmo tempo nunca fazem um ponto mais antigo
	// sobrescrever um mais novo (antes: ler-comparar-gravar em passos separados).
	const advanced = await prisma.conversationRead.updateMany({
		where: { ...where, lastReadAt: { lt: target } },
		data: { lastReadAt: target, ...(messageId ? { lastReadMessageId: messageId } : {}), manualUnread: false },
	});
	if (advanced.count === 0) {
		const existing = await prisma.conversationRead.findUnique({ where: { userId_conversationId: where } });
		const created = existing
			? false
			: await prisma.conversationRead
					.create({ data: { ...where, lastReadAt: target, lastReadMessageId: messageId, manualUnread: false } })
					.then(() => true)
					.catch(() => false); // linha criada em paralelo
		// Ponto igual ou mais novo já gravado: só limpa a marca manual.
		if (!created) await prisma.conversationRead.updateMany({ where, data: { manualUnread: false } });
	}
	// Resultados de rotina em background contam como vistos (cancela o aviso por e-mail pendente).
	await markConversationResultsSeen({ userId: input.userId, conversationId: input.conversationId, now }).catch(() => 0);
	return getUnreadState(input.userId, input.conversationId);
}

/** "Marcar como não lido": acende a bolinha em todos os dispositivos até a próxima leitura. */
export async function markConversationUnread(input: {
	userId: string;
	conversationId: string;
	now?: Date;
}): Promise<ConversationUnread> {
	const now = input.now ?? new Date();
	const key = { userId_conversationId: { userId: input.userId, conversationId: input.conversationId } };
	const existing = await prisma.conversationRead.findUnique({ where: key });
	if (existing) {
		await prisma.conversationRead.update({ where: key, data: { manualUnread: true } });
	} else {
		await prisma.conversationRead.create({
			data: { userId: input.userId, conversationId: input.conversationId, lastReadAt: now, manualUnread: true },
		});
	}
	return getUnreadState(input.userId, input.conversationId);
}
