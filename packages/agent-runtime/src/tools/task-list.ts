import type { ChatTool } from "@workspace/llm";
import { MAX_TASK_LIST_ITEMS, isTaskListDone, normalizeTaskListInput, type TaskListItem } from "@workspace/shared";

/**
 * `update_task_list`: checklist visível de uma tarefa de vários passos (semântica de substituir a
 * lista inteira, como o TodoWrite do Claude Code). A lista mora no TaskState do run (checkpoint),
 * volta ao próximo run da mesma conversa e é reinjetada como nota a cada passo.
 */

export const UPDATE_TASK_LIST_TOOL_NAME = "update_task_list";

export const UPDATE_TASK_LIST_TOOL: ChatTool = {
	type: "function",
	function: {
		name: UPDATE_TASK_LIST_TOOL_NAME,
		description:
			"Keeps a short step list for the task you are working on, shown to the user and reminded to you every turn. " +
			"USE WHEN the task has 3 or more distinct steps, or will span several turns. DO NOT USE for a trivial request, a single lookup or a quick answer. " +
			"Each call REPLACES the whole list: send every step with its current status. Mark a step completed as soon as it is done, and set the next one in_progress. " +
			`At most one step is in_progress at a time. Up to ${MAX_TASK_LIST_ITEMS} short steps. Send an empty list (or complete every step) to finish.`,
		parameters: {
			type: "object",
			properties: {
				items: {
					type: "array",
					description: "The full list, in order.",
					items: {
						type: "object",
						properties: {
							content: { type: "string", description: "Short imperative description of the step." },
							status: { type: "string", enum: ["pending", "in_progress", "completed"] },
						},
						required: ["content", "status"],
					},
				},
			},
			required: ["items"],
		},
	},
};

/** Onde a lista mora: o `TaskTracker` do run. */
export type TaskListStore = {
	get(): TaskListItem[] | undefined;
	set(next: TaskListItem[] | undefined): void;
};

/** `items` é a lista final para o cartão da thread (vazia = remover o cartão). */
export function executeUpdateTaskList(args: Record<string, unknown>, ctx: { taskListStore?: TaskListStore }): { summary: string; items: TaskListItem[] } {
	const store = ctx.taskListStore;
	if (!store) throw new Error("update_task_list is not available in this run.");
	const items = normalizeTaskListInput(args.items);
	if (items.length === 0) {
		store.set(undefined);
		return { summary: "Task list cleared.", items: [] };
	}
	if (isTaskListDone(items)) {
		store.set(undefined);
		return { summary: `All ${items.length} steps completed; list closed. Give the user the final result.`, items };
	}
	store.set(items);
	const done = items.filter((item) => item.status === "completed").length;
	return { summary: `Task list saved: ${done}/${items.length} completed. Continue with the step in progress.`, items };
}
