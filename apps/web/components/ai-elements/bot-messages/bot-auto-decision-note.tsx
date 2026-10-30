"use client";

import { BotIcon, CheckIcon, ChevronRightIcon, MessageCircleQuestionIcon, XIcon } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@workspace/ui/components/collapsible";
import { Marker, MarkerContent } from "@workspace/ui/components/marker";
import { useTranslations } from "@/lib/i18n/provider";

export type BotAutoDecisionNoteProps = {
	decision: "approved" | "rejected" | "answered";
	/** Frase pronta: "Aprovado por <bot> + Jev: <comando> — <motivo>". */
	note: string;
	subject: string;
	reason: string;
	status?: "queued" | "applied" | "failed";
};

const ICON = { approved: CheckIcon, rejected: XIcon, answered: MessageCircleQuestionIcon } as const;

/**
 * Nota de auditoria discreta: o orquestrador (com o Jev) decidiu pelo usuário. Fechada
 * mostra uma linha; aberta mostra o comando inteiro e o motivo.
 */
export function BotAutoDecisionNote({ decision, note, subject, reason, status = "applied" }: BotAutoDecisionNoteProps) {
	const { t } = useTranslations();
	const Icon = ICON[decision] ?? BotIcon;
	return (
		<Collapsible className="my-2" data-testid="bot-auto-decision">
			<Marker className="justify-center text-xs">
				<CollapsibleTrigger
					aria-label={t("aiElements.bots.decisionDetails")}
					className="group/trigger inline-flex max-w-full min-w-0 cursor-pointer items-center gap-1 rounded-md px-1 text-muted-foreground hover:text-foreground"
				>
					<Icon aria-hidden className="size-3.5 shrink-0" />
					<MarkerContent className="min-w-0 truncate">{note}</MarkerContent>
					<ChevronRightIcon aria-hidden className="size-3 shrink-0 transition-transform group-data-[panel-open]/trigger:rotate-90" />
				</CollapsibleTrigger>
			</Marker>
			<CollapsibleContent className="mx-auto mt-1 flex max-w-md flex-col gap-1 text-muted-foreground text-xs">
				<pre className="m-0 max-h-32 overflow-auto rounded-lg bg-muted/40 px-2 py-1 font-mono whitespace-pre-wrap [overflow-wrap:anywhere]" data-testid="bot-auto-decision-subject">
					{subject}
				</pre>
				{reason ? <p className="m-0">{reason}</p> : null}
				{status === "failed" ? <p className="m-0">{t("aiElements.bots.decisionFailed")}</p> : null}
			</CollapsibleContent>
		</Collapsible>
	);
}
