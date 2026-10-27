import { parseConversationCard } from "@workspace/shared";
import { prisma } from "./client.js";

/** Por quanto tempo "já pedi login neste site" vale na conversa. */
export const LOGIN_ASK_WINDOW_MS = 30 * 60 * 1000;

/**
 * Sites para os quais a conversa já mostrou o card de login nos últimos 30 min (captcha não conta).
 * Vale entre runs da mesma conversa: o guarda por run (checkpoint) não evitava o card em loop quando
 * cada mensagem do usuário abria um run novo. Escopo por dono: conversa de outro usuário devolve [].
 */
export async function listRecentLoginAskSites(
	userId: string,
	conversationId: string,
	now: Date = new Date(),
	windowMs: number = LOGIN_ASK_WINDOW_MS,
): Promise<string[]> {
	if (!userId.trim() || userId === "default") return [];
	const owned = await prisma.conversation.findFirst({ where: { id: conversationId, userId }, select: { id: true } });
	if (!owned) return [];
	const rows = await prisma.conversationMessage.findMany({
		where: { conversationId, role: "login", createdAt: { gte: new Date(now.getTime() - windowMs) } },
		orderBy: { createdAt: "desc" },
		take: 20,
		select: { content: true },
	});
	const sites = new Set<string>();
	for (const row of rows) {
		const card = parseConversationCard(row.content);
		if (card?.kind === "login" && card.reason !== "captcha") sites.add(card.site);
	}
	return [...sites];
}
