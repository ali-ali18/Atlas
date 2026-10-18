import { DISLIKE_EMOJI, normalizeReactionEmoji, toBotReactionEmoji, type MessageReaction } from "@workspace/shared";
import { prisma } from "./client.js";

/**
 * Reações a falas da conversa: uma por ator (`user` = o dono, `bot` = o bot da conversa) e mensagem.
 * Só falas de usuário/assistente aceitam reação (cartões não). O dono é sempre conferido pela conversa.
 */

const REACTABLE_ROLES = new Set(["user", "assistant"]);

type Row = { messageId: string; actorKind: string; emoji: string };

function toReaction(row: Row): MessageReaction {
	return { actor: row.actorKind === "bot" ? "bot" : "user", emoji: row.emoji };
}

/** Reações por mensagem (só ids com reação aparecem no mapa). Ordem: a mais antiga primeiro. */
export async function loadReactionsByMessage(messageIds: readonly string[]): Promise<Map<string, MessageReaction[]>> {
	const result = new Map<string, MessageReaction[]>();
	if (messageIds.length === 0) return result;
	const rows = await prisma.messageReaction.findMany({
		where: { messageId: { in: [...messageIds] } },
		orderBy: [{ createdAt: "asc" }, { id: "asc" }],
		select: { messageId: true, actorKind: true, emoji: true },
	});
	for (const row of rows) result.set(row.messageId, [...(result.get(row.messageId) ?? []), toReaction(row)]);
	return result;
}

/** A mensagem existe, é uma fala e está numa conversa do usuário? */
async function findOwnedMessage(userId: string, messageId: string): Promise<{ id: string; conversationId: string; role: string } | null> {
	if (!userId.trim() || userId === "default" || !messageId.trim()) return null;
	const row = await prisma.conversationMessage.findFirst({
		where: {
			id: messageId,
			conversation: { userId, OR: [{ bot: { is: null } }, { bot: { is: { ownerId: userId } } }] },
		},
		select: { id: true, conversationId: true, role: true },
	});
	return row && REACTABLE_ROLES.has(row.role) ? row : null;
}

export type SetReactionResult = { conversationId: string; reactions: MessageReaction[] } | null;

/**
 * O usuário reage (`emoji`) ou tira a reação (`null`). `null` no retorno = mensagem inexistente, de outro
 * usuário ou que não aceita reação; emoji inválido lança `RangeError`.
 */
export async function setUserReaction(input: { userId: string; messageId: string; emoji: string | null }): Promise<SetReactionResult> {
	const emoji = input.emoji === null ? null : normalizeReactionEmoji(input.emoji);
	if (input.emoji !== null && !emoji) throw new RangeError("emoji inválido");
	const message = await findOwnedMessage(input.userId, input.messageId);
	if (!message) return null;
	const key = { messageId: message.id, actorKind: "user", actorId: input.userId };
	if (emoji) {
		await prisma.messageReaction.upsert({
			where: { messageId_actorKind_actorId: key },
			create: { ...key, emoji },
			update: { emoji },
		});
	} else {
		await prisma.messageReaction.deleteMany({ where: key });
	}
	return { conversationId: message.conversationId, reactions: (await loadReactionsByMessage([message.id])).get(message.id) ?? [] };
}

/** Reações atuais de uma mensagem do usuário (para a outra aba atualizar depois do aviso do hub). */
export async function getOwnedMessageReactions(userId: string, messageId: string): Promise<SetReactionResult> {
	const message = await findOwnedMessage(userId, messageId);
	if (!message) return null;
	return { conversationId: message.conversationId, reactions: (await loadReactionsByMessage([message.id])).get(message.id) ?? [] };
}

/** O bot reage a uma fala da conversa dele (emoji fora do conjunto fixo vira 👍). */
export async function setBotReaction(input: { userId: string; botId: string; messageId: string; emoji: string }): Promise<boolean> {
	const message = await findOwnedMessage(input.userId, input.messageId);
	if (!message) return false;
	const bot = await prisma.bot.findFirst({ where: { id: input.botId, ownerId: input.userId }, select: { id: true } });
	if (!bot) return false;
	const emoji = toBotReactionEmoji(input.emoji);
	const key = { messageId: message.id, actorKind: "bot", actorId: bot.id };
	await prisma.messageReaction.upsert({ where: { messageId_actorKind_actorId: key }, create: { ...key, emoji }, update: { emoji } });
	return true;
}

/** Falas do assistente que o usuário marcou com 👎 desde `since` (nota leve para a reflexão diária). */
export async function listDislikedReplies(input: { userId: string; conversationIds: readonly string[]; since: Date; limit?: number }): Promise<Array<{ conversationId: string; text: string; at: Date }>> {
	if (input.conversationIds.length === 0) return [];
	const rows = await prisma.messageReaction.findMany({
		where: {
			actorKind: "user",
			actorId: input.userId,
			emoji: DISLIKE_EMOJI,
			updatedAt: { gt: input.since },
			message: { role: "assistant", conversationId: { in: [...input.conversationIds] } },
		},
		orderBy: { updatedAt: "desc" },
		take: input.limit ?? 20,
		select: { updatedAt: true, message: { select: { conversationId: true, content: true } } },
	});
	return rows.map((row) => ({ conversationId: row.message.conversationId, text: row.message.content, at: row.updatedAt }));
}
