import { prisma } from "./client.js";

/**
 * Bot dono da conversa, para chavear o perfil do navegador da VM por usuário+bot (e não por conversa).
 * Escopo por dono: conversa de outro usuário devolve null. Conversa de grupo (bot com membros) não conta:
 * o membro usa a VM da própria conversa. null = sem bot (a VM cai no perfil por conversa).
 */
export async function getProfileBotId(userId: string, conversationId: string): Promise<string | null> {
	const bot = await prisma.bot.findFirst({
		where: { conversationId, ownerId: userId, memberIds: { isEmpty: true } },
		select: { id: true },
	});
	return bot?.id ?? null;
}
