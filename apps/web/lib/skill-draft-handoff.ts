import type { SkillProposalData } from "@workspace/shared";
import type { SkillForm } from "@/components/settings/skills-state";

/** Proposta do chat que o editor vai resolver ao salvar ("Editar antes"). */
export type SkillProposalResolveContext = { conversationId: string; proposal: SkillProposalData };

export type SkillDraftHandoff = { form: SkillForm; resolve?: SkillProposalResolveContext };

/**
 * Passa um rascunho de skill de outra tela (ex.: "Editar antes" do card do
 * chat) para o editor da seção Habilidades, que abre em seguida no modal.
 * Uso único: `take` esvazia, então recarregar a página não reabre o editor.
 */
let pending: SkillDraftHandoff | null = null;

export function setPendingSkillDraft(handoff: SkillDraftHandoff): void {
	pending = handoff;
}

export function takePendingSkillDraft(): SkillDraftHandoff | null {
	const handoff = pending;
	pending = null;
	return handoff;
}

/** Avisa o chat (card) e a lista de Habilidades que uma proposta foi resolvida. */
export type SkillProposalResolvedEvent = { proposalId: string; status: "approved" | "rejected" };

const listeners = new Set<(event: SkillProposalResolvedEvent) => void>();

export function emitSkillProposalResolved(event: SkillProposalResolvedEvent): void {
	for (const listener of [...listeners]) listener(event);
}

export function subscribeSkillProposalResolved(listener: (event: SkillProposalResolvedEvent) => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
