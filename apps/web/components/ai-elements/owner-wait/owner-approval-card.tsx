"use client";

import { ClockIcon, FilePenLineIcon, ShieldAlertIcon } from "lucide-react";

import { Button } from "@workspace/ui/components/button";
import { RequestCard, REQUEST_PRIMARY_CLASS } from "@workspace/ui/components/request-card";
import { useTranslations } from "@/lib/i18n/provider";
import { ownerWaitDeadlineText, parseApprovalDetails } from "@/lib/owner-wait";
import { ApprovalFields } from "./approval-fields";

export type OwnerApprovalCardProps = {
	/** `draft`: a rotina (sem pessoa) deixou a ação pronta; `approval`: o bot pede para fazer agora. */
	variant: "approval" | "draft";
	title: string;
	/** Linhas "campo: valor" do servidor (no rascunho, a nota da rotina vem antes, separada por linha em branco). */
	description?: string;
	deadlineAt?: string;
	disabled?: boolean;
	onAllow?: () => void;
	onNotNow?: () => void;
	/** Relógio injetável (testes). */
	now?: Date;
	timeZone?: string;
};

/**
 * Cartão genérico de aprovação do motor v3 (pendente): "Permitir · Agora não", o que vai ser feito em lista legível e,
 * com prazo, "Sigo sem isso às 14:30" (o prazo nunca aprova). Decidido, a conversa mostra o marcador de uma linha.
 */
export function OwnerApprovalCard({ variant, title, description, deadlineAt, disabled, onAllow, onNotNow, now, timeZone }: OwnerApprovalCardProps) {
	const translator = useTranslations();
	const { t } = translator;
	const draft = variant === "draft";
	const { note, fields } = parseApprovalDetails(description, draft, translator);
	const deadline = ownerWaitDeadlineText(deadlineAt, now ?? new Date(), translator, timeZone ? { timeZone } : {});
	return (
		<RequestCard
			actions={
				<>
					<Button className={REQUEST_PRIMARY_CLASS} disabled={disabled} onClick={onAllow} size="sm" type="button">
						{t("ownerWait.approval.allow")}
					</Button>
					<Button disabled={disabled} onClick={onNotNow} size="sm" type="button" variant="secondary">
						{t("ownerWait.approval.notNow")}
					</Button>
				</>
			}
			badge={{ tone: "pending", label: t("chat.questionnaire.needsYou") }}
			label={draft ? t("ownerWait.draft.label") : t("ownerWait.approval.label")}
			data-owner-card={variant}
			description={draft ? t("ownerWait.draft.intro") : undefined}
			leading={draft ? <FilePenLineIcon aria-hidden /> : <ShieldAlertIcon aria-hidden />}
			note={
				deadline ? (
					<span className="inline-flex items-center gap-1" data-slot="owner-wait-deadline">
						<ClockIcon aria-hidden className="size-3.5" />
						{deadline}
					</span>
				) : undefined
			}
			title={title}
		>
			{note ? <p className="m-0 whitespace-pre-line text-body text-foreground [overflow-wrap:anywhere]">{note}</p> : null}
			<p className="m-0 text-caption text-muted-foreground">{t("ownerWait.approval.details")}</p>
			<ApprovalFields emptyLabel={t("ownerWait.noArgs")} fields={fields} />
		</RequestCard>
	);
}
