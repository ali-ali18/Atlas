// Porta `TaskListStore`: lista de tarefas DO RUN (F2.4). Nunca atravessa runs: o kernel não injeta estado de tarefa de
// outro run. Escopada pelo dono; o adaptador padrão (`adapters/task-list.ts`) guarda no caderno de trabalho do run.
import type { TaskListItem } from "@workspace/shared";

/** O que a entrega final do run é, declarado pelo modelo na própria lista (nunca deduzido de texto). */
export const TASK_DELIVERABLES = ["document", "answer"] as const;
export type TaskDeliverable = (typeof TASK_DELIVERABLES)[number];

export type TaskListState = { items: TaskListItem[]; deliverable?: TaskDeliverable };

export interface TaskListStore {
	get(userId: string, runId: string): Promise<TaskListState | null>;
	set(userId: string, runId: string, state: TaskListState): Promise<void>;
}
