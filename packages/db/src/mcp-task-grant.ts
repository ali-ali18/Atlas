import { MCP_TASK_GRANT_MAX_USES, mcpTaskGrantExpiry } from "@workspace/shared";
import { prisma } from "./client.js";

export type McpTaskGrantKey = { userId: string; conversationId: string; connectionId: string; exposedName: string };
export type McpTaskGrantUse = { uses: number; maxUses: number; confirmId: string | null };

/**
 * Concede (ou renova) a aprovação por tarefa depois de o dono aprovar o cartão. A chamada aprovada
 * já conta como o primeiro uso. Só concede em conversa do próprio dono (404 silencioso: `false`).
 */
export async function grantMcpTask(input: McpTaskGrantKey & { confirmId?: string; now?: Date; maxUses?: number }): Promise<McpTaskGrantUse | null> {
	const owned = await prisma.conversation.findFirst({ where: { id: input.conversationId, userId: input.userId }, select: { id: true } });
	if (!owned) return null;
	const expiresAt = mcpTaskGrantExpiry(input.now ?? new Date());
	const maxUses = input.maxUses ?? MCP_TASK_GRANT_MAX_USES;
	const row = await prisma.mcpTaskGrant.upsert({
		where: { conversationId_connectionId_exposedName: { conversationId: input.conversationId, connectionId: input.connectionId, exposedName: input.exposedName } },
		create: { userId: input.userId, conversationId: input.conversationId, connectionId: input.connectionId, exposedName: input.exposedName, confirmId: input.confirmId ?? null, uses: 1, maxUses, expiresAt },
		update: { userId: input.userId, confirmId: input.confirmId ?? null, uses: 1, maxUses, expiresAt },
	});
	return { uses: row.uses, maxUses: row.maxUses, confirmId: row.confirmId };
}

/**
 * Consome um uso, atomicamente (duas chamadas em paralelo nunca passam do teto). `null` = sem concessão
 * válida (outro dono, outra conversa/conexão/tool, vencida ou esgotada).
 */
export async function consumeMcpTaskGrant(input: McpTaskGrantKey & { now?: Date }): Promise<McpTaskGrantUse | null> {
	const now = input.now ?? new Date();
	const rows = await prisma.$queryRaw<Array<{ uses: number; maxUses: number; confirmId: string | null }>>`
		UPDATE "mcp_task_grants"
		SET "uses" = "uses" + 1, "updatedAt" = ${now}
		WHERE "conversationId" = ${input.conversationId}
			AND "userId" = ${input.userId}
			AND "connectionId" = ${input.connectionId}
			AND "exposedName" = ${input.exposedName}
			AND "uses" < "maxUses"
			AND "expiresAt" > ${now}
		RETURNING "uses", "maxUses", "confirmId"`;
	return rows[0] ?? null;
}

/** Limpeza de concessões vencidas (chamada oportunista; a tabela é minúscula). */
export async function deleteExpiredMcpTaskGrants(now: Date = new Date()): Promise<number> {
	const result = await prisma.mcpTaskGrant.deleteMany({ where: { expiresAt: { lte: now } } });
	return result.count;
}
