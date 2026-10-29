"use client";

import { CheckCircle2Icon, CircleIcon, ListChecksIcon } from "lucide-react";
import { Spinner } from "@workspace/ui/components/spinner";

import { ChatCard, ChatCardDetails, ChatCardLeading } from "@workspace/ui/components/chat-card";
import { seeAllLabel } from "@workspace/ui/lib/chat-card-copy";
import { cn } from "@workspace/ui/lib/utils";

import { taskListProgress, taskListSettledLabel, type TaskItem } from "@/lib/task-list";

export type TaskListCardItem = TaskItem;

export type TaskListCardProps = {
	items: readonly TaskListCardItem[];
	/** Abre a lista (testes/prévias). Por padrão fica recolhida. */
	defaultOpen?: boolean;
};

/** Os passos, um por linha, com um ícone por estado. Compartilhada com a doca do composer. */
export function TaskListItems({ items, className }: { items: readonly TaskListCardItem[]; className?: string }) {
	return (
		<ol className={cn("m-0 flex list-none flex-col gap-1 p-0 text-caption leading-snug", className)}>
			{items.map((item, index) => (
				<li
					key={`${index}-${item.content}`}
					className={cn(
						"flex items-start gap-2",
						item.status === "completed" ? "text-muted-foreground line-through" : item.status === "in_progress" ? "font-medium text-foreground" : "text-muted-foreground",
					)}
					data-status={item.status}
				>
					{item.status === "completed" ? (
						<CheckCircle2Icon aria-label="Concluído" className="mt-0.5 size-3.5 shrink-0" />
					) : item.status === "in_progress" ? (
						<Spinner label="Em andamento" className="mt-0.5 size-3.5 shrink-0" />
					) : (
						<CircleIcon aria-label="Pendente" className="mt-0.5 size-3.5 shrink-0" />
					)}
					<span className="min-w-0 break-words">{item.content}</span>
				</li>
			))}
		</ol>
	);
}

/**
 * Resumo na conversa de uma lista de tarefas que já terminou: "Tarefas · 5/5 concluídas" (ou "3/5" se o run
 * parou antes). Expande para os passos. Durante o run a lista vive na doca do composer (`TaskListDock`).
 */
export function TaskListCard({ items, defaultOpen = false }: TaskListCardProps) {
	const { total, allDone } = taskListProgress(items);
	if (total === 0) return null;

	return (
		<ChatCard variant="activity" className="my-1 w-full text-xs" data-testid="task-list-card" data-state={allDone ? "done" : "stopped"}>
			<ChatCardDetails
				defaultOpen={defaultOpen}
				label={seeAllLabel(total)}
				summary={
					<span className="flex min-w-0 items-center gap-2">
						<ChatCardLeading>{allDone ? <CheckCircle2Icon /> : <ListChecksIcon />}</ChatCardLeading>
						<span className="min-w-0 truncate font-medium text-foreground">{taskListSettledLabel(items)}</span>
					</span>
				}
			>
				<TaskListItems items={items} />
			</ChatCardDetails>
		</ChatCard>
	);
}
