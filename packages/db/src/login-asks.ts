import { parseConversationCard } from "@workspace/shared";
import { prisma } from "./client.js";

/** Por quanto tempo "já pedi login neste site" (e "o Cofre falhou aqui") vale na conversa. */
export const LOGIN_ASK_WINDOW_MS = 30 * 60 * 1000;

export type RecentLoginAsks = {
	/** Sites com card de login ainda pendente (o usuário não concluiu): não repetir o card. Captcha não conta. */
	asked: string[];
	/** Sites onde o login do Cofre foi tentado e o site ainda pediu a pessoa: não tentar o Cofre de novo. */
	vaultTried: string[];
};

/**
 * Cards de login da conversa nos últimos 30 min, por site. Vale entre runs da mesma conversa: o guarda por
 * run (checkpoint) não evitava o card em loop quando cada mensagem do usuário abria um run novo.
 * Login que o usuário já concluiu (card "done") deixa de suprimir: se a sessão cair de novo, o card volta.
 * Escopo por dono: conversa de outro usuário devolve listas vazias.
 */
export async function listRecentLoginAsks(
	userId: string,
	conversationId: string,
	now: Date = new Date(),
	windowMs: number = LOGIN_ASK_WINDOW_MS,
): Promise<RecentLoginAsks> {
	const empty: RecentLoginAsks = { asked: [], vaultTried: [] };
	if (!userId.trim() || userId === "default") return empty;
	const owned = await prisma.conversation.findFirst({ where: { id: conversationId, userId }, select: { id: true } });
	if (!owned) return empty;
	const rows = await prisma.conversationMessage.findMany({
		where: { conversationId, role: "login", createdAt: { gte: new Date(now.getTime() - windowMs) } },
		orderBy: { createdAt: "desc" },
		take: 20,
		select: { content: true },
	});
	const asked = new Set<string>();
	const vaultTried = new Set<string>();
	for (const row of rows) {
		const card = parseConversationCard(row.content);
		if (card?.kind !== "login") continue;
		if (card.vaultTried) vaultTried.add(card.site);
		if (card.reason !== "captcha" && card.status === "pending") asked.add(card.site);
	}
	return { asked: [...asked], vaultTried: [...vaultTried] };
}
