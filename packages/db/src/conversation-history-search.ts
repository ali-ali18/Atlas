import { prisma } from "./client.js";

/**
 * Busca no histórico COMPLETO da conversa atual (o que a compactação por resumo e a higiene de
 * prompt tiram do contexto do modelo): falas gravadas em `conversation_messages` e resultados
 * completos de ferramenta dos runs anteriores da mesma conversa (`agent_steps`).
 *
 * Escopo: uma conversa só, e só do dono. O dono e a conversa vêm da sessão do run, nunca do modelo.
 */
export type ConversationHistoryHit = {
	source: "message" | "tool_result";
	/** Papel da fala (`message`) ou nome da ferramenta (`tool_result`). */
	label: string;
	content: string;
	createdAt: string;
	runId?: string;
};

const DEFAULT_LIMIT = 6;
const MAX_LIMIT = 12;

type Row = { label: string | null; content: string | null; createdAt: Date; runId?: string | null };

const toHit = (source: ConversationHistoryHit["source"]) => (row: Row): ConversationHistoryHit => ({
	source,
	label: row.label ?? (source === "message" ? "message" : "tool"),
	content: row.content ?? "",
	createdAt: row.createdAt.toISOString(),
	...(row.runId ? { runId: row.runId } : {}),
});

/** Mesmo critério de dono de `searchConversationMessages` (conversa e bot sem outro dono). */
async function ownsConversation(userId: string, conversationId: string): Promise<boolean> {
	const rows = await prisma.$queryRaw<Array<{ id: string }>>`
		SELECT c."id" FROM "conversations" c LEFT JOIN "bots" b ON b."conversationId" = c."id"
		WHERE c."id" = ${conversationId}
			AND (c."userId" IS NULL OR c."userId" = ${userId})
			AND (b."ownerId" IS NULL OR b."ownerId" = ${userId})
		LIMIT 1`;
	return rows.length > 0;
}

export async function searchConversationHistory(
	query: string,
	opts: { userId: string; conversationId: string; limit?: number },
): Promise<ConversationHistoryHit[]> {
	const q = query.trim().slice(0, 200);
	const userId = opts.userId?.trim();
	const conversationId = opts.conversationId?.trim();
	if (!q || !userId || userId === "default" || !conversationId) return [];
	const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(opts.limit ?? DEFAULT_LIMIT)));
	if (!(await ownsConversation(userId, conversationId))) return [];
	const like = `%${q.replace(/[\%_]/g, "\$&")}%`;

	const messages = async (): Promise<ConversationHistoryHit[]> => {
		try {
			const rows = await prisma.$queryRaw<Row[]>`
				SELECT cm."role" AS "label", cm."content", cm."createdAt"
				FROM "conversation_messages" cm
				WHERE cm."conversationId" = ${conversationId}
					AND cm."role" IN ('user', 'assistant', 'system', 'tool')
					AND to_tsvector('portuguese', cm."content") @@ plainto_tsquery('portuguese', ${q})
				ORDER BY ts_rank(to_tsvector('portuguese', cm."content"), plainto_tsquery('portuguese', ${q})) DESC, cm."createdAt" DESC
				LIMIT ${limit}`;
			if (rows.length > 0) return rows.map(toHit("message"));
		} catch (error) {
			console.error("conversation history search (messages) failed; falling back to contains", error);
		}
		const rows = await prisma.$queryRaw<Row[]>`
			SELECT cm."role" AS "label", cm."content", cm."createdAt"
			FROM "conversation_messages" cm
			WHERE cm."conversationId" = ${conversationId}
				AND cm."role" IN ('user', 'assistant', 'system', 'tool')
				AND cm."content" ILIKE ${like}
			ORDER BY cm."createdAt" DESC
			LIMIT ${limit}`;
		return rows.map(toHit("message"));
	};

	const toolResults = async (): Promise<ConversationHistoryHit[]> => {
		try {
			const rows = await prisma.$queryRaw<Row[]>`
				SELECT COALESCE(s."inputJson"->>'name', 'tool') AS "label", s."outputJson"->>'summary' AS "content", s."createdAt", s."runId"
				FROM "agent_steps" s JOIN "agent_runs" r ON r."id" = s."runId"
				WHERE r."conversationId" = ${conversationId}
					AND r."userId" = ${userId}
					AND s."type" IN ('tool', 'tool_result')
					AND s."outputJson"->>'summary' IS NOT NULL
					AND to_tsvector('portuguese', s."outputJson"->>'summary') @@ plainto_tsquery('portuguese', ${q})
				ORDER BY ts_rank(to_tsvector('portuguese', s."outputJson"->>'summary'), plainto_tsquery('portuguese', ${q})) DESC, s."createdAt" DESC
				LIMIT ${limit}`;
			if (rows.length > 0) return rows.map(toHit("tool_result"));
		} catch (error) {
			console.error("conversation history search (tool results) failed; falling back to contains", error);
		}
		const rows = await prisma.$queryRaw<Row[]>`
			SELECT COALESCE(s."inputJson"->>'name', 'tool') AS "label", s."outputJson"->>'summary' AS "content", s."createdAt", s."runId"
			FROM "agent_steps" s JOIN "agent_runs" r ON r."id" = s."runId"
			WHERE r."conversationId" = ${conversationId}
				AND r."userId" = ${userId}
				AND s."type" IN ('tool', 'tool_result')
				AND s."outputJson"->>'summary' ILIKE ${like}
			ORDER BY s."createdAt" DESC
			LIMIT ${limit}`;
		return rows.map(toHit("tool_result"));
	};

	const [fromMessages, fromTools] = await Promise.all([messages(), toolResults()]);
	return [...fromMessages, ...fromTools];
}
