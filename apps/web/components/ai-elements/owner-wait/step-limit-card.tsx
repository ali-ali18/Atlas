"use client";

import { CheckIcon, GaugeIcon, SquareIcon } from "lucide-react";
import type { StepLimitProgress } from "@workspace/shared";

import { Button } from "@workspace/ui/components/button";
import { RequestCard, REQUEST_PRIMARY_CLASS } from "@workspace/ui/components/request-card";
import { formatCurrency } from "@/lib/format";
import { useTranslations } from "@/lib/i18n/provider";
import type { Translator } from "@/lib/i18n/translator";

export type StepLimitCardProps = {
	/** Título e descrição vêm do servidor ("Cheguei no limite de 40 passos. Continuo?"). */
	title: string;
	description?: string;
	progress?: StepLimitProgress;
	status: "pending" | "approved" | "rejected" | "failed";
	disabled?: boolean;
	onContinue?: () => void;
	onStop?: () => void;
};

/** "Fiz 40 passos · gastei US$ 0,12 · 3 de 5 tarefas concluídas" (só o que se sabe). */
export function stepLimitSummary(progress: StepLimitProgress | undefined, translator: Translator): string | null {
	if (!progress) return null;
	const parts = [translator.tn("ownerWait.limit.steps", progress.steps)];
	if (progress.costUsd) parts.push(translator.t("ownerWait.limit.spent", { amount: formatCurrency(progress.costUsd, "USD", translator.locale) }));
	if (progress.tasksTotal) parts.push(translator.t("ownerWait.limit.tasks", { done: String(progress.tasksDone?.length ?? 0), total: String(progress.tasksTotal) }));
	return parts.join(" · ");
}

/**
 * Cartão "Cheguei no limite. Continuo?" da rotina do motor v3: resumo do que já foi feito e "Continuar · Agora não".
 * Fica na conversa (não vai para a doca de aprovações): é uma decisão sobre a tarefa, não sobre uma ação.
 */
export function StepLimitCard({ title, description, progress, status, disabled, onContinue, onStop }: StepLimitCardProps) {
	const translator = useTranslations();
	const { t } = translator;
	const resolved = status !== "pending";
	const continued = status === "approved";
	const summary = stepLimitSummary(progress, translator);
	const tasks = progress?.tasksDone ?? [];
	return (
		<RequestCard
			actions={
				<>
					<Button className={REQUEST_PRIMARY_CLASS} disabled={disabled} onClick={onContinue} size="sm" type="button">
						{t("ownerWait.limit.continue")}
					</Button>
					<Button disabled={disabled} onClick={onStop} size="sm" type="button" variant="secondary">
						{t("ownerWait.limit.notNow")}
					</Button>
				</>
			}
			badge={resolved ? (continued ? { tone: "success", label: t("ownerWait.limit.continued") } : { tone: "muted", label: t("ownerWait.limit.stopped") }) : { tone: "pending", label: t("chat.questionnaire.needsYou") }}
			data-owner-card="step-limit"
			description={resolved ? (continued ? t("ownerWait.limit.continuedBody") : t("ownerWait.limit.stoppedBody")) : description}
			leading={resolved ? continued ? <CheckIcon aria-hidden /> : <SquareIcon aria-hidden /> : <GaugeIcon aria-hidden />}
			resolved={resolved}
			title={title}
		>
			{summary || tasks.length > 0 ? (
				<div className="flex min-w-0 flex-col gap-1.5" data-slot="step-limit-progress">
					{summary ? <p className="m-0 text-body font-medium text-foreground">{summary}</p> : null}
					{tasks.length > 0 ? (
						<>
							<p className="m-0 text-caption text-muted-foreground">{t("ownerWait.limit.doneList")}</p>
							<ul className="m-0 flex list-none flex-col gap-1 p-0">
								{tasks.map((task, index) => (
									<li className="flex min-w-0 items-start gap-2 text-body text-muted-foreground" key={`${index}-${task}`}>
										<CheckIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-success" />
										<span className="min-w-0 [overflow-wrap:anywhere]">{task}</span>
									</li>
								))}
							</ul>
						</>
					) : null}
				</div>
			) : null}
		</RequestCard>
	);
}
