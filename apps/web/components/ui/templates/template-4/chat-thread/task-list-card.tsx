"use client";

import { CheckCircle2Icon, CircleIcon } from "lucide-react";
import { Spinner } from "@workspace/ui/components/spinner";
import { useState } from "react";

import { ChatCard, ChatCardDetails, ChatCardLeading } from "@workspace/ui/components/chat-card";
import { seeAllLabel } from "@workspace/ui/lib/chat-card-copy";
import { cn } from "@workspace/ui/lib/utils";

export type TaskListCardItem = { content: string; status: "pending" | "in_progress" | "completed" };

export type TaskListCardProps = {
	items: readonly TaskListCardItem[];
	/** Força aberto/fechado; sem isso fica aberto enquanto há passo pendente e recolhe quando tudo conclui. */
	defaultOpen?: boolean;
};

/** Checklist compacta dos passos da tarefa; recolhe sozinha quando todos concluem. O usuário pode abrir/fechar. */
export function TaskListCard({ items, defaultOpen }: TaskListCardProps) {
	const [override, setOverride] = useState<boolean | null>(null);
	const total = items.length;
	const done = items.filter((item) => item.status === "completed").length;
	const allDone = total > 0 && done === total;
	const open = override ?? defaultOpen ?? !allDone;
	const current = items.find((item) => item.status === "in_progress");
	if (total === 0) return null;

	return (
		<ChatCard variant="activity" className="my-1 w-full text-xs" data-testid="task-list-card" data-state={allDone ? "done" : "active"}>
			<ChatCardDetails
				label={seeAllLabel(total)}
				onOpenChange={setOverride}
				open={open}
				summary={
					<span className="flex min-w-0 items-center gap-2">
						<ChatCardLeading>{allDone ? <CheckCircle2Icon /> : <Spinner />}</ChatCardLeading>
						<span className="shrink-0 font-medium text-foreground">{allDone ? "Tarefas concluídas" : "Tarefas"}</span>
						<span className="shrink-0 text-muted-foreground tabular-nums">{done}/{total}</span>
						{!open && current ? <span className="min-w-0 truncate text-muted-foreground">· {current.content}</span> : null}
					</span>
				}
			>
				<ol className="m-0 flex list-none flex-col gap-1 p-0">
					{items.map((item, index) => (
						<li
							key={`${index}-${item.content}`}
							className={cn(
								"flex items-start gap-2 leading-snug",
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
			</ChatCardDetails>
		</ChatCard>
	);
}
