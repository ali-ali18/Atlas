"use client";

import { ChevronRightIcon, SparklesIcon } from "lucide-react";
import { Badge } from "@workspace/ui/components/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@workspace/ui/components/collapsible";
import { ConfirmCard } from "@/components/ai-elements/confirm/confirm-card";
import { useTranslations } from "@/lib/i18n/provider";
import { SkillMarkdownPreview } from "@/components/settings/sections/skills/skill-markdown-preview";
import {
	type SkillProposalData,
	canEditProposal,
	proposalActionBadge,
	proposalResolvedCaption,
	proposalScopeLabel,
	proposalSummary,
	proposalTitle,
} from "./skill-proposal";

export type SkillProposalCardProps = {
	/** O estado (pendente/aprovada/recusada) vem em `proposal.status`. */
	proposal: SkillProposalData;
	bots?: readonly { id: string; name: string }[];
	/** true enquanto a decisão é aplicada: trava os botões. */
	isApplying?: boolean;
	error?: string | null;
	/** Só para teste/estado inicial: corpo já aberto. */
	defaultOpen?: boolean;
	onApprove?: () => void;
	onReject?: () => void;
	/** "Editar antes": abre o editor das Habilidades já preenchido (não existe na exclusão). */
	onEditFirst?: () => void;
};

/**
 * Card de aprovação do `propose_skill`/`delete_skill`: ação, nome, escopo e
 * descrição, o Markdown recolhido para conferir e Aprovar / Recusar / Editar
 * antes. A exclusão usa "Apagar" destrutivo e não tem editor. Usa o mesmo
 * ConfirmCard dos outros pedidos de confirmação do chat.
 */
export function SkillProposalCard({
	proposal,
	bots = [],
	isApplying = false,
	error,
	defaultOpen = false,
	onApprove,
	onReject,
	onEditFirst,
}: SkillProposalCardProps) {
	const translator = useTranslations();
	const { t } = translator;
	const isDelete = proposal.action === "delete";
	const caption = proposalResolvedCaption(proposal, translator);
	return (
		<ConfirmCard
			cancelLabel={t("aiElements.skills.card.reject")}
			confirmLabel={isApplying ? t("aiElements.skills.card.applying") : isDelete ? t("aiElements.skills.card.delete") : t("aiElements.skills.card.approve")}
			description={proposalSummary(proposal, bots, translator)}
			destructive={isDelete}
			detailsLabel={t("aiElements.skills.card.view")}
			disabled={isApplying}
			error={error}
			leading={<SparklesIcon aria-hidden />}
			note={caption ? <span data-slot="skill-proposal-resolved">{caption}</span> : undefined}
			editLabel={t("aiElements.skills.card.editFirst")}
			onCancel={onReject}
			onConfirm={onApprove}
			onEdit={canEditProposal(proposal) ? onEditFirst : undefined}
			status={proposal.status}
			title={proposalTitle(proposal, translator)}
		>
			<div className="flex min-w-0 flex-col gap-2 rounded-xl bg-background/70 px-3 py-2.5 ring-1 ring-foreground/5" data-slot="skill-proposal">
				<div className="flex min-w-0 flex-wrap items-center gap-2">
					<span className="min-w-0 truncate font-mono text-sm font-medium">{proposal.name}</span>
					<Badge variant="outline">{proposalScopeLabel(proposal, bots, translator)}</Badge>
					<Badge variant={isDelete ? "destructive" : "secondary"}>{proposalActionBadge(proposal.action, translator)}</Badge>
				</div>
				<p className="text-sm text-muted-foreground">{proposal.description}</p>
				<Collapsible defaultOpen={defaultOpen}>
					<CollapsibleTrigger className="group/trigger flex items-center gap-1.5 rounded-sm text-xs font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/30">
						<ChevronRightIcon aria-hidden className="size-3.5 transition-transform group-aria-expanded/trigger:rotate-90" />
						{isDelete ? t("aiElements.skills.card.viewCurrent") : t("aiElements.skills.card.viewContent")}
					</CollapsibleTrigger>
					<CollapsibleContent>
						<div className="mt-2 max-h-64 overflow-y-auto rounded-lg bg-muted/50 p-3">
							<SkillMarkdownPreview markdown={proposal.body} />
						</div>
					</CollapsibleContent>
				</Collapsible>
			</div>
		</ConfirmCard>
	);
}
