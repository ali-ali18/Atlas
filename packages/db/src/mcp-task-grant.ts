import { randomUUID } from "node:crypto";
import { MCP_TASK_GRANT_MAX_LIFETIME_MS, MCP_TASK_GRANT_MAX_USES, MCP_TASK_GRANT_TTL_MS } from "@workspace/shared";
import { prisma } from "./client.js";

export type McpTaskGrantKey = { userId: string; conversationId: string; connectionId: string; exposedName: string };
export type McpTaskGrantUse = { uses: number; maxUses: number; confirmId: string | null; /** Só no consumo: quando a conversa leu conteúdo externo (decide se o Jev é obrigatório). */ untrustedAt?: Date | null };

/**
 * Concede (ou renova) a aprovação por tarefa depois de o dono aprovar o cartão. A chamada aprovada
 * já conta como um uso. Só concede em conversa do próprio dono (`null` silencioso).
 *
 * Renovar uma concessão ainda válida mantém `uses`, `maxUses`, `createdAt` e `untrustedAt` e nunca passa de
 * `createdAt + 2h`; só uma concessão vencida recomeça (contador zerado, sem marca de conteúdo externo).
 * Tudo num único INSERT ... ON CONFLICT (sem corrida entre duas aprovações).
 */
export async function grantMcpTask(input: McpTaskGrantKey & { confirmId?: string; now?: Date; maxUses?: number; /** O cartão foi levantado depois de conteúdo externo: a concessão já nasce marcada (Jev obrigatório em cada uso). */ untrusted?: boolean }): Promise<McpTaskGrantUse | null> {
	const owned = await prisma.conversation.findFirst({ where: { id: input.conversationId, userId: input.userId }, select: { id: true } });
	if (!owned) return null;
	const now = input.now ?? new Date();
	// Tabela minúscula: a limpeza dos vencidos acompanha cada concessão nova.
	await deleteExpiredMcpTaskGrants(now).catch(() => 0);
	const maxUses = input.maxUses ?? MCP_TASK_GRANT_MAX_USES;
	const expiresAt = new Date(now.getTime() + MCP_TASK_GRANT_TTL_MS);
	const lifetimeSeconds = MCP_TASK_GRANT_MAX_LIFETIME_MS / 1000;
	const rows = await prisma.$queryRaw<Array<{ uses: number; maxUses: number; confirmId: string | null }>>`
		INSERT INTO "mcp_task_grants" ("id", "userId", "conversationId", "connectionId", "exposedName", "confirmId", "uses", "maxUses", "expiresAt", "createdAt", "updatedAt", "untrustedAt")
		VALUES (${randomUUID()}, ${input.userId}, ${input.conversationId}, ${input.connectionId}, ${input.exposedName}, ${input.confirmId ?? null}, 1, ${maxUses}, ${expiresAt}, ${now}, ${now}, ${input.untrusted ? now : null})
		ON CONFLICT ("conversationId", "connectionId", "exposedName") DO UPDATE SET
			"userId" = EXCLUDED."userId",
			"confirmId" = EXCLUDED."confirmId",
			"updatedAt" = EXCLUDED."updatedAt",
			"uses" = CASE WHEN "mcp_task_grants"."expiresAt" > ${now} THEN LEAST("mcp_task_grants"."uses" + 1, "mcp_task_grants"."maxUses") ELSE 1 END,
			"maxUses" = CASE WHEN "mcp_task_grants"."expiresAt" > ${now} THEN "mcp_task_grants"."maxUses" ELSE EXCLUDED."maxUses" END,
			"createdAt" = CASE WHEN "mcp_task_grants"."expiresAt" > ${now} THEN "mcp_task_grants"."createdAt" ELSE EXCLUDED."createdAt" END,
			"untrustedAt" = CASE WHEN "mcp_task_grants"."expiresAt" > ${now} THEN COALESCE("mcp_task_grants"."untrustedAt", EXCLUDED."untrustedAt") ELSE EXCLUDED."untrustedAt" END,
			"expiresAt" = CASE WHEN "mcp_task_grants"."expiresAt" > ${now}
				THEN LEAST(EXCLUDED."expiresAt", "mcp_task_grants"."createdAt" + ${lifetimeSeconds}::double precision * interval '1 second')
				ELSE EXCLUDED."expiresAt" END
		WHERE "mcp_task_grants"."userId" = ${input.userId}
		RETURNING "uses", "maxUses", "confirmId"`;
	return rows[0] ?? null;
}

/**
 * Consome um uso, atomicamente (duas chamadas em paralelo nunca passam do teto). `null` = sem concessão
 * válida (outro dono, outra conversa/conexão/tool, vencida ou esgotada). `untrustedAt` volta junto: conteúdo externo
 * NÃO bloqueia o consumo aqui, o runtime decide (Jev obrigatório em cada uso).
 */
export async function consumeMcpTaskGrant(input: McpTaskGrantKey & { now?: Date }): Promise<McpTaskGrantUse | null> {
	const now = input.now ?? new Date();
	const rows = await prisma.$queryRaw<Array<{ uses: number; maxUses: number; confirmId: string | null; untrustedAt: Date | null }>>`
		UPDATE "mcp_task_grants"
		SET "uses" = "uses" + 1, "updatedAt" = ${now}
		WHERE "conversationId" = ${input.conversationId}
			AND "userId" = ${input.userId}
			AND "connectionId" = ${input.connectionId}
			AND "exposedName" = ${input.exposedName}
			AND "uses" < "maxUses"
			AND "expiresAt" > ${now}
		RETURNING "uses", "maxUses", "confirmId", "untrustedAt"`;
	return rows[0] ?? null;
}

/** Devolve um uso consumido que não chegou a executar (o Jev mandou perguntar no lugar). */
export async function releaseMcpTaskGrant(input: McpTaskGrantKey & { now?: Date }): Promise<void> {
	await prisma.$executeRaw`
		UPDATE "mcp_task_grants"
		SET "uses" = GREATEST("uses" - 1, 0), "updatedAt" = ${input.now ?? new Date()}
		WHERE "conversationId" = ${input.conversationId}
			AND "userId" = ${input.userId}
			AND "connectionId" = ${input.connectionId}
			AND "exposedName" = ${input.exposedName}`;
}

/**
 * A conversa leu conteúdo que o usuário não escreveu (e-mail, página, arquivo, subagente, conector): as
 * concessões dela ficam marcadas e passam a exigir a checagem de instrução externa do Jev em cada uso.
 */
export async function markMcpTaskGrantsUntrusted(input: { userId: string; conversationId: string; now?: Date }): Promise<number> {
	const result = await prisma.mcpTaskGrant.updateMany({
		where: { userId: input.userId, conversationId: input.conversationId, untrustedAt: null },
		data: { untrustedAt: input.now ?? new Date() },
	});
	return result.count;
}

/** Limpeza de concessões vencidas (chamada oportunista; a tabela é minúscula). */
export async function deleteExpiredMcpTaskGrants(now: Date = new Date()): Promise<number> {
	const result = await prisma.mcpTaskGrant.deleteMany({ where: { expiresAt: { lte: now } } });
	return result.count;
}
