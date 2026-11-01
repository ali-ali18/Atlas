import { Prisma } from "@prisma/client";
import { withEngineSettings, type EngineSettingsPatch } from "@workspace/shared";
import { prisma } from "./client.js";

/**
 * Motor do bot (piloto do motor v2): mescla só as chaves do motor em `policyJson`, relendo a linha sob lock
 * (FOR UPDATE) para não pisar em outra tela que grave o mesmo jsonb ao mesmo tempo. Filtra pelo dono na consulta;
 * `null` quando o bot não é do usuário (a tool/rota responde "não encontrado"). Devolve a política nova.
 */
export async function setBotEngineSettings(botId: string, userId: string, patch: EngineSettingsPatch): Promise<Record<string, unknown> | null> {
	if (!userId || userId === "default" || !botId) return null;
	return prisma.$transaction(async (tx) => {
		const rows = await tx.$queryRaw<Array<{ policyJson: unknown }>>`SELECT "policyJson" FROM "bots" WHERE "id" = ${botId} AND "ownerId" = ${userId} FOR UPDATE`;
		if (!rows[0]) return null;
		const next = withEngineSettings(rows[0].policyJson, patch);
		await tx.bot.update({ where: { id: botId, ownerId: userId }, data: { policyJson: next as Prisma.InputJsonValue } });
		return next;
	});
}
