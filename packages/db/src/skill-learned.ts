/**
 * Desfazer de skill que o agente gravou sozinho ("Aprendi: ..."). Toda consulta filtra por `userId` (skill de
 * outro dono = not_found, que a API responde 404). Só desfaz a revisão exata que o card anunciou: se o usuário
 * (ou outra edição) mexeu depois, a skill não é tocada (stale) para não perder trabalho.
 */
import { parseConversationCard, serializeConversationCard } from "@workspace/shared";
import { prisma } from "./client.js";
import { SkillDocError, deleteSkillDoc, getSkillDoc, updateSkillDoc } from "./skill-docs.js";

export type UndoLearnedResult = { result: "deleted" | "restored"; name: string };

export async function undoLearnedSkill(
	userId: string,
	skillId: string,
	input: { action: "created" | "updated"; revision: number },
): Promise<UndoLearnedResult> {
	const current = await getSkillDoc(userId, skillId);
	if (!current) throw new SkillDocError("not_found", "Skill não encontrada.");
	if (current.revision !== input.revision) {
		throw new SkillDocError("stale", "A skill foi alterada depois do aviso; edite ou apague pela lista de skills.");
	}
	if (input.action === "created") {
		// Só vale para o que o agente criou: desfazer não é um "apagar qualquer skill".
		if (current.createdBy !== "agent" || current.revision !== 1) {
			throw new SkillDocError("stale", "Essa skill não foi criada sozinha pelo agente; apague pela lista de skills.");
		}
		if (!(await deleteSkillDoc(userId, skillId))) throw new SkillDocError("not_found", "Skill não encontrada.");
		return { result: "deleted", name: current.name };
	}
	const previous = await prisma.skillRevision.findFirst({ where: { skillId, userId, revision: input.revision - 1 } });
	if (!previous) throw new SkillDocError("not_found", "A versão anterior não está mais guardada.");
	await updateSkillDoc(userId, skillId, {
		description: previous.description,
		body: previous.body,
		expectedRevision: input.revision,
		updatedBy: "user",
	});
	return { result: "restored", name: current.name };
}

/** Marca como desfeito o card "Aprendi" da skill na conversa (o dono já foi checado por quem chama). */
export async function markLearnedSkillCardUndone(conversationId: string, skillId: string): Promise<boolean> {
	const recent = await prisma.conversationMessage.findMany({
		where: { conversationId, role: "skill" },
		orderBy: { createdAt: "desc" },
		take: 30,
	});
	for (const row of recent) {
		const card = parseConversationCard(row.content);
		if (card?.kind !== "skill" || !card.learned || card.skillId !== skillId || card.undone) continue;
		await prisma.conversationMessage.update({ where: { id: row.id }, data: { content: serializeConversationCard({ ...card, undone: true }) } });
		return true;
	}
	return false;
}
