"use client";

import { CalendarClockIcon } from "lucide-react";
import type { AgendaAction, AgendaItemView } from "@workspace/shared";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@workspace/ui/components/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@workspace/ui/components/empty";
import { useT, useTranslations } from "@/lib/i18n/provider";
import { type AgendaActionResult, AgendaCard } from "./agenda-card";
import { agendaCardModel } from "./agenda-text";

/** Lista da Agenda: ativos e pausados, o estado vazio e os encerrados recolhidos. Pura (dados por props) para teste. */
export function AgendaList({
	items,
	ended,
	timezone,
	now,
	onAction,
	endedOpen,
}: {
	items: readonly AgendaItemView[];
	ended: readonly AgendaItemView[];
	timezone: string;
	now: Date;
	onAction?: (item: AgendaItemView, action: AgendaAction) => Promise<AgendaActionResult>;
	/** Só para teste/prévia: já abre os encerrados. */
	endedOpen?: boolean;
}) {
	const t = useT();
	const translator = useTranslations();
	const card = (item: AgendaItemView) => (
		<AgendaCard
			item={item}
			key={item.id}
			model={agendaCardModel(item, timezone, now, translator)}
			onAction={onAction}
		/>
	);
	return (
		<div className="flex flex-col gap-3">
			{items.length === 0 ? (
				<Empty className="gap-2 p-4" data-agenda-empty>
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<CalendarClockIcon />
						</EmptyMedia>
						<EmptyTitle className="text-body">{t("agenda.empty.title")}</EmptyTitle>
						<EmptyDescription className="text-caption">{t("agenda.empty.body")}</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : (
				<ul aria-label={t("agenda.listLabel")} className="m-0 flex list-none flex-col gap-2 p-0">
					{items.map(card)}
				</ul>
			)}
			{ended.length > 0 ? (
				<Collapsible defaultOpen={endedOpen}>
					<CollapsibleTrigger className="rounded-md text-caption text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50">
						{t("agenda.ended.show", { count: ended.length })}
					</CollapsibleTrigger>
					<CollapsibleContent className="pt-2">
						<ul className="m-0 flex list-none flex-col gap-2 p-0">{ended.map(card)}</ul>
					</CollapsibleContent>
				</Collapsible>
			) : null}
		</div>
	);
}
