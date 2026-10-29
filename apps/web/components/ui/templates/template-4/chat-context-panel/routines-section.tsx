"use client";

import type { ReactElement, ReactNode } from "react";
import { Button } from "@workspace/ui/components/button";
import { useT } from "@/lib/i18n/provider";
import type { Routine } from "../data";
import { RoutineCard } from "./routine-card";
import { groupRoutinesForPanel, RoutineGroupBlock, type RoutineGroupHandlers } from "./routine-group-block";

export type RoutineCardHandlers = {
	onDelete?: (routine: Routine) => void;
	onEdit?: (routine: Routine) => void;
	onOpenGithub?: (routine: Routine) => void;
	onOpenHistory?: (routine: Routine) => void;
	onOpenWebhook?: (routine: Routine) => void;
	onRun?: (routine: Routine) => unknown;
	onToggle?: (routine: Routine, enabled: boolean) => Promise<string | null>;
	isPersisted?: (routine: Routine) => boolean;
};

export type RoutineExecution = { id: string; name: string; time: string };

/** Quantas execuções recentes o histórico mostra. */
const HISTORY_SHOWN = 4;

/** Histórico curto das últimas execuções (dentro da seção Rotinas). */
export function ExecutionHistory({ executions }: { executions: readonly RoutineExecution[] }) {
	const t = useT();
	return (
		<section aria-labelledby="info-pane-history" className="space-y-2">
			<h3 className="font-medium text-muted-foreground text-xs" id="info-pane-history">
				{t("routines.section.history")}
			</h3>
			{executions.length === 0 ? (
				<p className="text-muted-foreground text-xs">{t("routines.history.empty")}</p>
			) : (
				<ul className="flex flex-col gap-2 rounded-2xl border border-border bg-card px-3 py-2.5">
					{executions.slice(-HISTORY_SHOWN).map((run) => (
						<li className="flex items-center justify-between gap-2 text-xs" key={run.id}>
							<span className="min-w-0 flex-1 truncate">{run.name}</span>
							<span className="shrink-0 text-muted-foreground">{run.time}</span>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

/**
 * Conteúdo da seção Rotinas: lista com toggles (ou o convite a criar a primeira), lembretes do modo proativo
 * (`extra`) e o histórico de execuções. O botão "+" mora no cabeçalho da seção.
 */
export function RoutinesSectionBody({
	routines,
	groups = [],
	executions,
	cards,
	groupHandlers,
	createChooser,
	extra,
}: {
	routines: readonly Routine[];
	groups?: ReadonlyArray<{ id: string; name: string }>;
	executions: readonly RoutineExecution[];
	cards: RoutineCardHandlers;
	groupHandlers: RoutineGroupHandlers;
	createChooser: (trigger: ReactElement) => ReactNode;
	extra?: ReactNode;
}) {
	const t = useT();
	const renderCard = (routine: Routine) => (
		<RoutineCard
			key={routine.id}
			onDelete={cards.onDelete}
			onEdit={cards.onEdit}
			onOpenGithub={cards.onOpenGithub}
			onOpenHistory={cards.onOpenHistory}
			onOpenWebhook={cards.onOpenWebhook}
			onRun={cards.onRun}
			onToggle={cards.onToggle}
			persisted={cards.isPersisted?.(routine) ?? false}
			routine={routine}
		/>
	);
	return (
		<div className="flex flex-col gap-5">
			{routines.length === 0 ? (
				<div className="flex flex-col items-center gap-2 py-4 text-center">
					<p className="text-muted-foreground text-xs leading-relaxed">{t("routines.section.intro")}</p>
					{createChooser(
						<Button size="sm" variant="outline">
							{t("routines.section.create")}
						</Button>,
					)}
				</div>
			) : (
				<ul className="flex flex-col gap-2">
					{groupRoutinesForPanel([...routines], [...groups]).map((item) => {
						if (item.kind === "routine") return renderCard(item.routine);
						return (
							<RoutineGroupBlock
								id={item.group.id}
								key={`group-${item.group.id}`}
								name={item.group.name}
								onDelete={groupHandlers.onDelete}
								onRename={groupHandlers.onRename}
								onSetEnabled={groupHandlers.onSetEnabled}
								routines={item.routines}
							>
								{item.routines.map(renderCard)}
							</RoutineGroupBlock>
						);
					})}
				</ul>
			)}
			{extra}
			<ExecutionHistory executions={executions} />
		</div>
	);
}
