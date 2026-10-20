import { parseConversationCard, serializeConversationCard, type TaskListItem } from "@workspace/shared";
import { prisma } from "./client.js";
import { appendConversationCard } from "./conversations.js";

/**
 * Cartão da lista de passos (`update_task_list`): um por run, atualizado no lugar a cada chamada
 * (mantém a posição na thread). Lista vazia remove o cartão.
 */
export async function upsertTaskListCard(
	conversationId: string | null | undefined,
	runId: string | null | undefined,
	items: readonly TaskListItem[],
): Promise<void> {
	if (!conversationId || !runId) return;
	const recent = await prisma.conversationMessage.findMany({
		where: { conversationId, role: "task-list" },
		orderBy: { createdAt: "desc" },
		take: 20,
		select: { id: true, content: true },
	});
	const existing = recent.find((row) => {
		const card = parseConversationCard(row.content);
		return card?.kind === "task-list" && card.runId === runId;
	});
	if (items.length === 0) {
		if (existing) await prisma.conversationMessage.delete({ where: { id: existing.id } });
		return;
	}
	const card = parseConversationCard(JSON.stringify({ v: 1, kind: "task-list", runId, items }));
	if (card?.kind !== "task-list") return;
	if (existing) {
		await prisma.conversationMessage.update({ where: { id: existing.id }, data: { content: serializeConversationCard(card) } });
		return;
	}
	await appendConversationCard(conversationId, card);
}
