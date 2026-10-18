import { openSettingsModal } from "@/components/settings/settings-url";
import { setPendingSkillDraft } from "@/lib/skill-draft-handoff";
import { type SkillProposalData, canEditProposal, proposalToForm } from "./skill-proposal";

/**
 * "Editar antes": deixa o rascunho (e a proposta a resolver) para o editor e abre
 * Configurações em Habilidades. Ao salvar, o editor resolve a proposta com o
 * documento revisado em vez de criar a skill direto.
 */
export function openSkillProposalInEditor(proposal: SkillProposalData, conversationId: string): void {
	if (!canEditProposal(proposal)) return;
	setPendingSkillDraft({ form: proposalToForm(proposal), resolve: { conversationId, proposal } });
	openSettingsModal("habilidades");
}
