"use client";

import { CoinsIcon } from "lucide-react";
import type { BudgetContinueData } from "@workspace/shared";
import { Button } from "@workspace/ui/components/button";
import { REQUEST_PRIMARY_CLASS, RequestCard } from "@workspace/ui/components/request-card";
import { formatCurrency } from "@/lib/format";
import { useTranslations } from "@/lib/i18n/provider";

export type BudgetContinueCardProps = {
	/** O estado (pendente/aprovado/dispensado) vem em `offer.status`. */
	offer: BudgetContinueData;
	/** true enquanto a decisão é aplicada: trava os botões. */
	isApplying?: boolean;
	error?: string | null;
	onApprove?: () => void;
	onDismiss?: () => void;
};

/**
 * Trabalho longo que parou por orçamento: "Continuar pesquisa (+US$ X)". É dinheiro, então só gasta com o toque da
 * pessoa; "Agora não" dispensa sem gastar. Decidido, só o selo e uma linha ficam.
 */
export function BudgetContinueCard({ offer, isApplying = false, error, onApprove, onDismiss }: BudgetContinueCardProps) {
	const { t, locale } = useTranslations();
	const amount = formatCurrency(offer.budgetUsd, "USD", locale);
	const resolved = offer.status !== "pending";
	const title =
		offer.status === "approved"
			? t("aiElements.budgetContinue.titleApproved")
			: offer.status === "dismissed"
				? t("aiElements.budgetContinue.titleDismissed")
				: t("aiElements.budgetContinue.title");
	const badge =
		offer.status === "approved"
			? ({ tone: "success", label: t("aiElements.budgetContinue.badgeApproved") } as const)
			: offer.status === "dismissed"
				? ({ tone: "muted", label: t("aiElements.budgetContinue.badgeDismissed") } as const)
				: ({ tone: "pending", label: t("aiElements.budgetContinue.badgePending") } as const);

	return (
		<RequestCard
			actions={
				<Button className={REQUEST_PRIMARY_CLASS} disabled={isApplying} onClick={onApprove} size="sm" type="button">
					{isApplying ? t("aiElements.budgetContinue.continuing") : t("aiElements.budgetContinue.continue", { amount })}
				</Button>
			}
			badge={badge}
			data-kind="budget-continue"
			description={resolved ? undefined : t("aiElements.budgetContinue.description", { amount })}
			error={error}
			leading={<CoinsIcon aria-hidden />}
			note={offer.status === "approved" ? t("aiElements.budgetContinue.noteApproved", { amount }) : undefined}
			resolved={resolved}
			title={title}
			trailing={
				<Button disabled={isApplying} onClick={onDismiss} size="sm" type="button" variant="ghost">
					{t("aiElements.budgetContinue.notNow")}
				</Button>
			}
		/>
	);
}
