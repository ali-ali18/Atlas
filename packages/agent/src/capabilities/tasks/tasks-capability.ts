// Capacidade `tasks` (F2.4): a lista de tarefas DO RUN. Vale só para o run (o kernel não injeta tarefa de outro run).
// `deliverable` é campo DECLARADO pelo modelo (o que a entrega final é); nenhuma decisão sai de texto.
import { MAX_TASK_LIST_CONTENT_CHARS, MAX_TASK_LIST_ITEMS, normalizeTaskListInput, type TaskListItem } from "@workspace/shared";
import { z } from "zod";
import { TASK_DELIVERABLES, type TaskListStore } from "../../ports/task-list.js";
import { defineTool } from "../../tools/define-tool.js";
import { defineCapability } from "../define-capability.js";

const MARKS: Readonly<Record<TaskListItem["status"], string>> = { pending: "[ ]", in_progress: "[>]", completed: "[x]" };

export function renderTaskList(items: readonly TaskListItem[]): string {
	return items.map((item, index) => `${index + 1}. ${MARKS[item.status]} ${item.content}`).join("\n");
}

export function createTasksCapability(store: TaskListStore) {
	const updateTaskList = defineTool({
		name: "update_task_list",
		description:
			"Write the checklist of a multi-step job (3 or more steps). Send the WHOLE list every time: it replaces the previous one. Keep one step in_progress at a time and mark steps completed as soon as they are done. " +
			"Set deliverable to say what the job ends with: document (a file, page or chart) or answer (a message). Send an empty list to clear it. Do not use it for one-step requests or small talk.",
		inputSchema: z.object({
			items: z
				.array(z.strictObject({ content: z.string().min(1).max(MAX_TASK_LIST_CONTENT_CHARS), status: z.enum(["pending", "in_progress", "completed"]) }))
				.max(MAX_TASK_LIST_ITEMS)
				.describe("Every step, in order."),
			deliverable: z.enum(TASK_DELIVERABLES).optional(),
		}),
		// A lista é rascunho de trabalho do próprio bot (não sai dele): `draft` roda sem pedir aprovação em qualquer autonomia.
		effect: "draft",
		async execute({ items, deliverable }, ctx) {
			let normalized: TaskListItem[];
			try {
				normalized = normalizeTaskListInput(items);
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error), hint: "Each item is { content, status }; status is pending, in_progress or completed; at most one in_progress." };
			}
			const previous = await store.get(ctx.ownerId, ctx.runId);
			const kept = deliverable ?? previous?.deliverable;
			await store.set(ctx.ownerId, ctx.runId, { items: normalized, ...(kept && { deliverable: kept }) });
			const done = normalized.filter((item) => item.status === "completed").length;
			const header = normalized.length === 0 ? "Task list cleared." : `Task list saved (${done}/${normalized.length} done).`;
			const tail = normalized.length > 0 && done === normalized.length ? "\nAll steps are done: give the owner the result." : "";
			return {
				ok: true,
				summary: `${header}${normalized.length > 0 ? `\n${renderTaskList(normalized)}` : ""}${kept ? `\nDeliverable: ${kept}.` : ""}${tail}`,
				receipt: { what: normalized.length === 0 ? "Cleared the task list" : `Task list: ${done} of ${normalized.length} done`, where: "This run" },
			};
		},
	});

	return defineCapability({
		id: "tasks",
		title: "Tarefas",
		summary: "Keep a checklist for multi-step jobs.",
		tools: [updateTaskList],
	});
}
