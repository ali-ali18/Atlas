/**
 * Proposta de skill do agente (`propose_skill` / `delete_skill`) como o card
 * mostra. Os tipos são os do contrato do K1 (`@workspace/shared`); aqui ficam
 * só os textos em pt-BR e as funções puras do card.
 */
import {
	renderSkillMarkdown,
	type SkillProposalAction,
	type SkillProposalData,
	type SkillProposalStatus,
} from "@workspace/shared";
import { parseToolsText, type SkillForm } from "@/components/settings/skills-state";

export type { SkillProposalAction, SkillProposalData, SkillProposalStatus };

type BotRefs = readonly { id: string; name: string }[];

export function proposalTitle(proposal: Pick<SkillProposalData, "action">): string {
	if (proposal.action === "delete") return "Apagar habilidade";
	return proposal.action === "edit" ? "Editar habilidade" : "Criar habilidade";
}

export function proposalActionBadge(action: SkillProposalAction): string {
	if (action === "delete") return "Exclusão";
	return action === "edit" ? "Edição" : "Nova";
}

export function proposalScopeLabel(proposal: Pick<SkillProposalData, "botId">, bots: BotRefs = []): string {
	if (!proposal.botId) return "Conta";
	return bots.find((bot) => bot.id === proposal.botId)?.name ?? "Bot específico";
}

/** Resumo em uma frase: o que vai acontecer se o usuário aprovar. */
export function proposalSummary(proposal: SkillProposalData, bots: BotRefs = []): string {
	const verb = proposal.action === "delete" ? "Apagar" : proposal.action === "edit" ? "Atualizar" : "Criar";
	const scope = proposal.botId ? `do bot ${proposalScopeLabel(proposal, bots)}` : "da sua conta";
	if (proposal.action === "delete") return `${verb} a habilidade "${proposal.name}" ${scope}. Não dá para desfazer.`;
	const target = proposal.botId ? `para o bot ${proposalScopeLabel(proposal, bots)}` : "para a sua conta";
	return `${verb} a habilidade "${proposal.name}" ${target}.`;
}

/** Texto do estado final (depois de aprovar ou recusar). `null` enquanto pendente. */
export function proposalResolvedCaption(proposal: Pick<SkillProposalData, "action" | "status">): string | null {
	if (proposal.status === "pending") return null;
	if (proposal.status === "rejected") return "Proposta recusada. Nada foi alterado.";
	if (proposal.action === "delete") return "Habilidade apagada.";
	return proposal.action === "edit" ? "Habilidade atualizada." : "Habilidade criada.";
}

/** "Editar antes" só existe quando há documento para editar (não na exclusão). */
export function canEditProposal(proposal: Pick<SkillProposalData, "action">): boolean {
	return proposal.action !== "delete";
}

/** Abre o editor já preenchido ("Editar antes"). */
export function proposalToForm(proposal: SkillProposalData): SkillForm {
	return {
		name: proposal.name,
		description: proposal.description,
		body: proposal.body,
		toolsText: proposal.tools.join(", "),
		botId: proposal.botId,
	};
}

/** Documento revisado que vai em `markdown` na aprovação ("editar antes"). */
export function formToProposalMarkdown(form: SkillForm): string {
	return renderSkillMarkdown({
		name: form.name.trim(),
		description: form.description.trim(),
		tools: parseToolsText(form.toolsText),
		body: form.body,
	});
}

/** Mensagem pt-BR para o erro do resolve (404/409/422/400). */
export function proposalErrorMessage(error: unknown): string {
	const status = typeof error === "object" && error !== null && "status" in error ? Number(error.status) : 0;
	const message = error instanceof Error ? error.message.trim() : "";
	switch (status) {
		case 404:
			return "Esta proposta não existe mais ou já foi resolvida.";
		case 409:
			return message
				? `${message} Peça ao agente para propor de novo.`
				: "A habilidade mudou ou já existe uma com esse nome. Peça ao agente para propor de novo.";
		case 422:
			return message || "Limite de habilidades atingido. Apague alguma antes de aprovar.";
		case 400:
			return message || "O documento da habilidade é inválido.";
		default:
			return "Não foi possível aplicar a proposta. Tente novamente.";
	}
}
