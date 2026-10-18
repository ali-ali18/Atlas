import { BOT_LINK_ROLE, parseBotNeedsUserCard, type ReactionGuardContext } from "@workspace/shared";
import { prisma } from "./client.js";
import { appendConversationMessage } from "./conversations.js";
import { isGroupConversation } from "./group-lookup.js";
import { setBotReaction } from "./message-reactions.js";
import { listActiveRunsForConversation } from "./runs.js";
import { getSkillPendingIntent } from "./skill-pending.js";

/**
 * Apoio ao "responder só com reação": o estado da conversa que as travas precisam e a gravação da mensagem
 * do usuário sem run (a reação do bot é a resposta).
 */

/** Cartões que podem estar esperando o usuário. Pendente com mais de 7 dias já não é resposta do "ok". */
const WAITING_CARD_ROLES = ["login", "confirm", "bot-profile", "questionnaire", "skill-proposal", "bot-proposal", "routine-proposal", BOT_LINK_ROLE];
const WAITING_CARD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const WAITING_CARD_SCAN = 40;

function isWaiting(role: string, content: string): boolean {
	if (role === BOT_LINK_ROLE) return parseBotNeedsUserCard(content)?.status === "pending";
	try {
		const status = (JSON.parse(content) as { status?: unknown }).status;
		return status === undefined || status === "pending";
	} catch {
		return false;
	}
}

export type ReactionStateContext = Pick<ReactionGuardContext, "isGroup" | "hasActiveRun" | "hasPendingCard" | "previous">;

/** Lê o que as travas precisam. Qualquer erro propaga: quem chama cai no fluxo normal. */
export async function getReactionStateContext(input: { userId: string; conversationId: string; now?: Date }): Promise<ReactionStateContext> {
	const now = input.now ?? new Date();
	const [isGroup, activeRuns, intent, cards, last] = await Promise.all([
		isGroupConversation(input.conversationId),
		listActiveRunsForConversation(input.conversationId),
		getSkillPendingIntent(input.userId, input.conversationId),
		prisma.conversationMessage.findMany({
			where: { conversationId: input.conversationId, role: { in: WAITING_CARD_ROLES }, createdAt: { gt: new Date(now.getTime() - WAITING_CARD_MAX_AGE_MS) } },
			orderBy: [{ createdAt: "desc" }, { id: "desc" }],
			take: WAITING_CARD_SCAN,
			select: { role: true, content: true },
		}),
		prisma.conversationMessage.findFirst({
			where: { conversationId: input.conversationId, role: { in: ["user", "assistant"] } },
			orderBy: [{ createdAt: "desc" }, { id: "desc" }],
			select: { role: true, content: true, createdAt: true },
		}),
	]);
	return {
		isGroup,
		hasActiveRun: activeRuns.length > 0,
		hasPendingCard: Boolean(intent) || cards.some((card) => isWaiting(card.role, card.content)),
		previous: last ? { role: last.role, text: last.content, at: last.createdAt } : null,
	};
}

/**
 * Grava a mensagem do usuário e a reação do bot, sem criar run. Confere de novo, na hora de gravar, que a
 * conversa continua sem run ativo (corrida com outro envio); `null` = não gravou, siga o fluxo normal.
 */
export async function recordReactionOnlyReply(input: {
	userId: string;
	botId: string;
	conversationId: string;
	content: string;
	emoji: string;
}): Promise<{ messageId: string; emoji: string } | null> {
	const [conversation, bot] = await Promise.all([
		prisma.conversation.findFirst({ where: { id: input.conversationId, userId: input.userId }, select: { id: true } }),
		prisma.bot.findFirst({ where: { id: input.botId, ownerId: input.userId }, select: { id: true } }),
	]);
	if (!conversation || !bot) return null;
	if ((await listActiveRunsForConversation(input.conversationId)).length > 0) return null;
	const message = await appendConversationMessage(input.conversationId, "user", input.content, "chat");
	const ok = await setBotReaction({ userId: input.userId, botId: input.botId, messageId: message.id, emoji: input.emoji });
	if (!ok) {
		await prisma.conversationMessage.delete({ where: { id: message.id } }).catch(() => undefined);
		return null;
	}
	return { messageId: message.id, emoji: input.emoji };
}
