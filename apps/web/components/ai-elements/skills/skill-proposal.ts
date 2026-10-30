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
import { defaultTranslator, type Translator } from "@/lib/i18n/translator";

export type { SkillProposalAction, SkillProposalData, SkillProposalStatus };

type BotRefs = readonly { id: string; name: string }[];

export function proposalTitle(proposal: Pick<SkillProposalData, "action">, { t }: Translator = defaultTranslator): string {
	if (proposal.action === "delete") return t("aiElements.skills.title.delete");
	return proposal.action === "edit" ? t("aiElements.skills.title.edit") : t("aiElements.skills.title.create");
}

export function proposalActionBadge(action: SkillProposalAction, { t }: Translator = defaultTranslator): string {
	if (action === "delete") return t("aiElements.skills.badge.delete");
	return action === "edit" ? t("aiElements.skills.badge.edit") : t("aiElements.skills.badge.create");
}

export function proposalScopeLabel(proposal: Pick<SkillProposalData, "botId">, bots: BotRefs = [], { t }: Translator = defaultTranslator): string {
	if (!proposal.botId) return t("aiElements.skills.scope.account");
	return bots.find((bot) => bot.id === proposal.botId)?.name ?? t("aiElements.skills.scope.specificBot");
}

/** Resumo em uma frase: o que vai acontecer se o usuário aprovar. */
export function proposalSummary(proposal: SkillProposalData, bots: BotRefs = [], translator: Translator = defaultTranslator): string {
	const { t } = translator;
	const bot = proposalScopeLabel(proposal, bots, translator);
	const { name } = proposal;
	if (proposal.action === "delete") return proposal.botId ? t("aiElements.skills.summary.deleteBot", { name, bot }) : t("aiElements.skills.summary.deleteAccount", { name });
	if (proposal.action === "edit") return proposal.botId ? t("aiElements.skills.summary.editBot", { name, bot }) : t("aiElements.skills.summary.editAccount", { name });
	return proposal.botId ? t("aiElements.skills.summary.createBot", { name, bot }) : t("aiElements.skills.summary.createAccount", { name });
}

/** Texto do estado final (depois de aprovar ou recusar). `null` enquanto pendente. */
export function proposalResolvedCaption(proposal: Pick<SkillProposalData, "action" | "status">, { t }: Translator = defaultTranslator): string | null {
	if (proposal.status === "pending") return null;
	if (proposal.status === "rejected") return t("aiElements.skills.caption.rejected");
	if (proposal.action === "delete") return t("aiElements.skills.caption.deleted");
	return proposal.action === "edit" ? t("aiElements.skills.caption.updated") : t("aiElements.skills.caption.created");
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

/** Mensagem (no idioma da tela) para o erro do resolve (404/409/422/400). */
export function proposalErrorMessage(error: unknown, { t }: Translator = defaultTranslator): string {
	const status = typeof error === "object" && error !== null && "status" in error ? Number(error.status) : 0;
	const message = error instanceof Error ? error.message.trim() : "";
	switch (status) {
		case 404:
			return t("aiElements.skills.error.404");
		case 409:
			return message ? t("aiElements.skills.error.409Message", { message }) : t("aiElements.skills.error.409");
		case 422:
			return message || t("aiElements.skills.error.422");
		case 400:
			return message || t("aiElements.skills.error.400");
		default:
			return t("aiElements.skills.error.default");
	}
}
