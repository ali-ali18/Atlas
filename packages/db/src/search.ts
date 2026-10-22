import { Prisma } from "@prisma/client";
import type { ChatRole } from "@workspace/shared";
import { prisma } from "./client.js";

export type ConversationSearchHit = {
	conversationId: string;
	role: ChatRole;
	content: string;
	createdAt: string;
};

const DEFAULT_LIMIT = 5;

type SearchRow = {
	conversationId: string;
	role: string;
	content: string;
	createdAt: Date;
};

function normalizeLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
		return DEFAULT_LIMIT;
	}
	return Math.floor(limit);
}

function toHit(row: SearchRow): ConversationSearchHit {
	return {
		conversationId: row.conversationId,
		role: row.role as ChatRole,
		content: row.content,
		createdAt: row.createdAt.toISOString(),
	};
}

export async function searchConversationMessages(
	query: string,
	opts?: { limit?: number; excludeConversationId?: string; userId?: string; botId?: string; groupConversationId?: string },
): Promise<ConversationSearchHit[]> {
	const trimmed = query.trim();
	if (trimmed.length === 0) {
		return [];
	}

	const limit = normalizeLimit(opts?.limit);
	const exclude = opts?.excludeConversationId;
	// Fase 4: filtro por usuário (via Conversation.userId ou Bot.ownerId).
	// Sem userId (chamada antiga), mantém o comportamento atual sem filtro.
	const userId = opts?.userId?.trim() ? (opts.userId as string).trim() : undefined;

	// Mesmo critério de `getOwnedConversation`: só entra se a conversa não
	// tiver outro dono E o bot vinculado (se houver) não tiver outro dono.
	// Legado sem dono (ambos NULL) continua visível até o backfill.
	// Isolamento por bot: cada bot tem a própria conversa (Bot.conversationId é
	// único). Com botId, só entram mensagens da conversa DESSE bot — sem isso o
	// bot enxergava (e citava) o que o usuário falou para os outros bots.
	const botId = opts?.botId?.trim() ? opts.botId.trim() : undefined;
	const needsJoin = Boolean(userId || botId);
	// Run dentro de um grupo: além da conversa do bot, a do grupo (só se o bot for membro dele).
	const groupConversationId = botId && opts?.groupConversationId?.trim() ? opts.groupConversationId.trim() : undefined;
	const botFilter = botId
		? groupConversationId
			? Prisma.sql` AND (b."id" = ${botId} OR (c."id" = ${groupConversationId} AND ${botId} = ANY(b."memberIds")))`
			: Prisma.sql` AND b."id" = ${botId}`
		: Prisma.empty;
	const ownerFilter = userId
		? Prisma.sql` AND (c."userId" IS NULL OR c."userId" = ${userId}) AND (b."ownerId" IS NULL OR b."ownerId" = ${userId})${botFilter}`
		: botFilter;
	// Escopo ANTES do casamento: o conjunto de conversas permitidas (dono/bot) é resolvido primeiro
	// (poucas linhas) e só então as mensagens dessas conversas são testadas contra o tsvector/ILIKE.
	// Mesmo critério de dono de antes, só que como semi-join (sem duplicar linha nem juntar por mensagem).
	const scopeFilter = needsJoin
		? Prisma.sql` AND cm."conversationId" IN (
					SELECT c."id" FROM "conversations" c LEFT JOIN "bots" b ON b."conversationId" = c."id"
					WHERE TRUE${ownerFilter})`
		: Prisma.empty;
	const excludeFilter = exclude
		? Prisma.sql` AND cm."conversationId" <> ${exclude}`
		: Prisma.empty;

	try {
		const rows = await prisma.$queryRaw<SearchRow[]>`
				SELECT cm."conversationId", cm."role", cm."content", cm."createdAt"
				FROM "conversation_messages" cm
				WHERE to_tsvector('portuguese', cm."content") @@ plainto_tsquery('portuguese', ${trimmed})
					AND cm."role" IN ('system', 'user', 'assistant', 'tool')
					${excludeFilter}
					${scopeFilter}
				ORDER BY ts_rank(to_tsvector('portuguese', cm."content"), plainto_tsquery('portuguese', ${trimmed})) DESC, cm."createdAt" DESC
				LIMIT ${limit}
			`;

		if (rows.length > 0) {
			return rows.map(toHit);
		}
	} catch (error) {
		console.error(
			"conversation full-text search failed; falling back to contains",
			error,
		);
	}

	// Fallback ILIKE também com JOIN de dono (evita Prisma relation complexa).
	try {
		if (userId || botId) {
			const likeRows = await prisma.$queryRaw<SearchRow[]>`
				SELECT cm."conversationId", cm."role", cm."content", cm."createdAt"
				FROM "conversation_messages" cm
				WHERE cm."content" ILIKE ${`%${trimmed.slice(0, 120)}%`}
					AND cm."role" IN ('system', 'user', 'assistant', 'tool')
					${excludeFilter}
					${scopeFilter}
				ORDER BY cm."createdAt" DESC
				LIMIT ${limit}
			`;
			if (likeRows.length > 0) return likeRows.map(toHit);
			return [];
		}
	} catch (error) {
		console.error(
			"conversation ilike search with owner filter failed; falling back to plain contains",
			error,
		);
	}

	const fallbackRows = await prisma.conversationMessage.findMany({
		where: {
			content: { contains: trimmed, mode: "insensitive" },
			role: { in: ["system", "user", "assistant", "tool"] },
			...(exclude ? { conversationId: { not: exclude } } : {}),
		},
		orderBy: { createdAt: "desc" },
		take: userId || botId ? limit * 4 : limit,
	});

	if (!userId && !botId) return fallbackRows.map(toHit);

	// Última rede: filtra em JS pelo dono (mesmo critério acima).
	const ids = [...new Set(fallbackRows.map((r) => r.conversationId))];
	if (ids.length === 0) return [];
	const convs = await prisma.conversation.findMany({
		where: { id: { in: ids } },
		select: { id: true, userId: true, bot: { select: { id: true, ownerId: true, memberIds: true } } },
	});
	const allowed = new Set(
		convs
			.filter(
				(c) =>
					(!userId || !c.userId || c.userId === userId) &&
					(!userId || !c.bot?.ownerId || c.bot.ownerId === userId) &&
					(!botId || c.bot?.id === botId || (c.id === groupConversationId && Boolean(c.bot?.memberIds?.includes(botId)))),
			)
			.map((c) => c.id),
	);
	return fallbackRows
		.filter((r) => allowed.has(r.conversationId))
		.slice(0, limit)
		.map(toHit);
}
