import { prisma } from "./client.js";

/** A conversa pertence a um grupo de bots? (a conversa do grupo nunca vira a de um membro). */
export async function isGroupConversation(conversationId: string | null | undefined): Promise<boolean> {
	if (!conversationId) return false;
	const group = await prisma.bot.findFirst({ where: { conversationId, memberIds: { isEmpty: false } }, select: { id: true } });
	return Boolean(group);
}

/** Autor (id/nome) da fala de `botId` na conversa, se ela for um grupo do qual o bot é membro. */
export async function getGroupAuthor(
	conversationId: string | null | undefined,
	botId: string | null | undefined,
): Promise<{ id: string; name: string } | null> {
	if (!conversationId || !botId) return null;
	const group = await prisma.bot.findFirst({ where: { conversationId, memberIds: { has: botId } }, select: { id: true } });
	if (!group) return null;
	const bot = await prisma.bot.findFirst({ where: { id: botId }, select: { id: true, name: true } });
	return bot ? { id: bot.id, name: bot.name } : null;
}
