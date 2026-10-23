import { Prisma } from "@prisma/client";
import { prisma } from "./client.js";

/**
 * Busca nas conversas dos OUTROS bots do mesmo usuário ("o que combinei com o bot de vendas sobre X?").
 * Só roda quando o usuário pede para olhar além do bot atual. Escopo estrito: o dono vem da sessão do
 * run (nunca do modelo), o bot precisa ser dele (sem o "dono nulo" legado) e só entram falas do usuário e
 * do assistente (sem resultados de ferramenta, que podem trazer dado de conectores de outro bot).
 */
export type UserConversationHit = {
	botId: string;
	botName: string;
	conversationId: string;
	role: string;
	content: string;
	createdAt: string;
};

type Row = { botId: string; botName: string; conversationId: string; role: string; content: string; createdAt: Date };

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;

const toHit = (row: Row): UserConversationHit => ({
	botId: row.botId,
	botName: row.botName,
	conversationId: row.conversationId,
	role: row.role,
	content: row.content,
	createdAt: row.createdAt.toISOString(),
});

const validDate = (value: Date | undefined) => (value && !Number.isNaN(value.getTime()) ? value : undefined);

export async function searchOtherBotsConversations(
	query: string,
	opts: { userId: string; excludeBotId?: string; since?: Date; until?: Date; limit?: number },
): Promise<UserConversationHit[]> {
	const q = query.trim().slice(0, 200);
	const userId = opts.userId?.trim();
	if (!q || !userId || userId === "default") return [];
	const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(opts.limit ?? DEFAULT_LIMIT)));
	const excludeBotId = opts.excludeBotId?.trim();
	const since = validDate(opts.since);
	const until = validDate(opts.until);
	const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;

	const scope = Prisma.sql`
		FROM "conversation_messages" cm
		JOIN "conversations" c ON c."id" = cm."conversationId"
		JOIN "bots" b ON b."conversationId" = c."id"
		WHERE b."ownerId" = ${userId}
			AND (c."userId" IS NULL OR c."userId" = ${userId})
			AND cm."role" IN ('user', 'assistant')
			${excludeBotId ? Prisma.sql`AND b."id" <> ${excludeBotId}` : Prisma.empty}
			${since ? Prisma.sql`AND cm."createdAt" >= ${since}` : Prisma.empty}
			${until ? Prisma.sql`AND cm."createdAt" < ${until}` : Prisma.empty}`;
	const columns = Prisma.sql`SELECT b."id" AS "botId", b."name" AS "botName", cm."conversationId", cm."role", cm."content", cm."createdAt"`;

	try {
		const rows = await prisma.$queryRaw<Row[]>`
			${columns} ${scope}
				AND to_tsvector('portuguese', cm."content") @@ plainto_tsquery('portuguese', ${q})
			ORDER BY ts_rank(to_tsvector('portuguese', cm."content"), plainto_tsquery('portuguese', ${q})) DESC, cm."createdAt" DESC
			LIMIT ${limit}`;
		if (rows.length > 0) return rows.map(toHit);
	} catch (error) {
		console.error("other bots conversation search failed; falling back to contains", error);
	}
	const rows = await prisma.$queryRaw<Row[]>`
		${columns} ${scope}
			AND cm."content" ILIKE ${like}
		ORDER BY cm."createdAt" DESC
		LIMIT ${limit}`;
	return rows.map(toHit);
}
