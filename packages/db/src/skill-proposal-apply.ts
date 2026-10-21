/**
 * Aplica uma proposta de skill aprovada pelo dono (PLANO-SKILLS K1). Usa só as
 * funções de `skill-docs.ts`, que filtram por `userId` na query: proposta de
 * outro dono não acha nada (not_found). Erros previsíveis chegam como
 * `SkillDocError` (validação, conflito de nome, revisão velha, limite).
 */
import type { SkillProposalData } from "@workspace/shared";
import { SkillDocError, createSkillDoc, deleteSkillDoc, getSkillDoc, updateSkillDoc } from "./skill-docs.js";

export async function applySkillProposal(
	userId: string,
	proposal: Pick<
		SkillProposalData,
		"action" | "name" | "description" | "tools" | "body" | "botId" | "skillId" | "expectedRevision"
	>,
): Promise<{ skillId: string | null; revision: number | null }> {
	if (proposal.action === "create") {
		const created = await createSkillDoc(userId, {
			botId: proposal.botId,
			name: proposal.name,
			description: proposal.description,
			body: proposal.body,
			tools: proposal.tools,
			createdBy: "agent",
		});
		return { skillId: created.id, revision: created.revision };
	}
	const skillId = proposal.skillId ?? "";
	if (proposal.action === "delete") {
		if (!(await getSkillDoc(userId, skillId)) || !(await deleteSkillDoc(userId, skillId))) {
			throw new SkillDocError("not_found", "Skill não encontrada.");
		}
		return { skillId: null, revision: null };
	}
	const updated = await updateSkillDoc(userId, skillId, {
		description: proposal.description,
		body: proposal.body,
		tools: proposal.tools,
		expectedRevision: proposal.expectedRevision,
		updatedBy: "agent",
	});
	return { skillId: updated.id, revision: updated.revision };
}
