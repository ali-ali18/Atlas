"use client";

import { CheckCircle2Icon, ChevronUpIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ChatCard, ChatCardLeading } from "@workspace/ui/components/chat-card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@workspace/ui/components/collapsible";
import { Spinner } from "@workspace/ui/components/spinner";

import { taskListDockLine, taskListProgress } from "@/lib/task-list";
import { TaskListItems, type TaskListCardItem } from "./task-list-card";

export type TaskListDockProps = {
	items: readonly TaskListCardItem[];
	/** Altura da doca (px), para a conversa deixar espaço embaixo. */
	onHeight?: (height: number) => void;
	/** Começa aberta (testes/prévias). */
	defaultOpen?: boolean;
};

/**
 * Lista de tarefas presa em cima do composer enquanto o run está ativo: uma linha com spinner e
 * "2/5 · tarefa em andamento"; tocar abre a lista inteira (ao vivo, com rolagem até ~40vh no celular).
 * Quando o run termina a doca some e a conversa fica com o resumo (`TaskListCard`).
 */
export function TaskListDock({ items, onHeight, defaultOpen = false }: TaskListDockProps) {
	const [open, setOpen] = useState(defaultOpen);
	const rootRef = useRef<HTMLDivElement>(null);
	const { total, allDone } = taskListProgress(items);

	useEffect(() => {
		const element = rootRef.current;
		if (!element || !onHeight || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => onHeight(element.offsetHeight));
		observer.observe(element);
		onHeight(element.offsetHeight);
		return () => {
			observer.disconnect();
			onHeight(0);
		};
	}, [onHeight]);

	if (total === 0) return null;
	return (
		<div className="mx-auto mb-2 w-full max-w-3xl" data-testid="task-list-dock" ref={rootRef}>
			<ChatCard aria-label="Tarefas do bot" className="w-full max-w-none gap-0 px-0 py-0" data-state={allDone ? "done" : "active"} variant="activity">
				<Collapsible onOpenChange={setOpen} open={open}>
					<CollapsibleTrigger
						aria-label={open ? "Recolher a lista de tarefas" : "Abrir a lista de tarefas"}
						className="group/trigger flex min-h-11 w-full min-w-0 items-center gap-2 rounded-2xl px-3 text-left text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
						data-testid="task-list-dock-toggle"
					>
						<ChatCardLeading>{allDone ? <CheckCircle2Icon /> : <Spinner />}</ChatCardLeading>
						<span className="min-w-0 flex-1 truncate tabular-nums" data-testid="task-list-dock-line">{taskListDockLine(items)}</span>
						<ChevronUpIcon aria-hidden className="size-4 shrink-0 text-muted-foreground transition-transform group-aria-expanded/trigger:rotate-180" />
					</CollapsibleTrigger>
					<CollapsibleContent>
						<div className="max-h-[40vh] overflow-y-auto px-3 pb-3" data-testid="task-list-dock-items">
							<TaskListItems items={items} />
						</div>
					</CollapsibleContent>
				</Collapsible>
			</ChatCard>
		</div>
	);
}

/**
 * Tudo o que fica preso em cima do composer. Ordem de cima para baixo: lista de tarefas (uma linha) e,
 * logo acima da caixa de digitar, a barra de aprovação, que tem prioridade.
 */
export function ComposerDock({ tasks, onTasksHeight, approval }: { tasks: readonly TaskListCardItem[] | null; onTasksHeight?: (height: number) => void; approval: React.ReactNode }) {
	return (
		<>
			{tasks ? <TaskListDock items={tasks} onHeight={onTasksHeight} /> : null}
			{approval}
		</>
	);
}
