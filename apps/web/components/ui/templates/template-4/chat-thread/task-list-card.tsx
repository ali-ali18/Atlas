"use client";

import { CheckCircle2Icon, ChevronDownIcon, CircleIcon } from "lucide-react";
import { Spinner } from "@workspace/ui/components/spinner";
import { useId, useState } from "react";

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
	const panelId = useId();
	const total = items.length;
	const done = items.filter((item) => item.status === "completed").length;
	const allDone = total > 0 && done === total;
	const open = override ?? defaultOpen ?? !allDone;
	const current = items.find((item) => item.status === "in_progress");
	if (total === 0) return null;

	return (
		<div
			className="my-1 w-full min-w-0 max-w-[min(68ch,100%)] rounded-lg border border-border/60 bg-muted/40 text-xs"
			data-testid="task-list-card"
			data-state={allDone ? "done" : "active"}
		>
			<button
				aria-controls={panelId}
				aria-expanded={open}
				className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-left text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
				onClick={() => setOverride(!open)}
				type="button"
			>
				{allDone ? <CheckCircle2Icon className="size-3.5 shrink-0" /> : <Spinner className="size-3.5 shrink-0" />}
				<span className="shrink-0 font-medium text-foreground/90">{allDone ? "Tarefas concluídas" : "Tarefas"}</span>
				<span className="shrink-0 tabular-nums">{done}/{total}</span>
				{!open && current ? <span className="min-w-0 truncate">· {current.content}</span> : null}
				<ChevronDownIcon className={cn("ml-auto size-3.5 shrink-0 transition-transform", open ? "rotate-180" : "")} />
			</button>
			{open ? (
				<ol className="m-0 flex list-none flex-col gap-1 px-3 pb-2.5 pl-3" id={panelId}>
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
			) : null}
		</div>
	);
}
