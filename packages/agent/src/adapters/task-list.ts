// Adaptador de `TaskListStore` sobre o caderno de trabalho do run (`NoteStore`): a lista fica numa nota `work:<run>:tasks`
// (escopada pelo dono como todo o caderno) e o `note_read` do próprio run consegue relê-la depois de uma compactação.
import { parseTaskList } from "@workspace/shared";
import type { NoteStore } from "../ports/store.js";
import { TASK_DELIVERABLES, type TaskDeliverable, type TaskListState, type TaskListStore } from "../ports/task-list.js";
import { WORK_NOTE_PREFIX } from "../kernel/work-notes.js";

export const taskListNoteId = (runId: string) => `${WORK_NOTE_PREFIX}${runId}:tasks`;

function isDeliverable(value: unknown): value is TaskDeliverable {
	return (TASK_DELIVERABLES as readonly unknown[]).includes(value);
}

export function createNoteTaskListStore(notes: NoteStore): TaskListStore {
	return {
		async get(userId, runId) {
			const note = await notes.get(userId, taskListNoteId(runId));
			if (!note) return null;
			try {
				const raw = JSON.parse(note.body) as { items?: unknown; deliverable?: unknown };
				const items = parseTaskList(raw.items) ?? [];
				return { items, ...(isDeliverable(raw.deliverable) && { deliverable: raw.deliverable }) };
			} catch {
				return null;
			}
		},
		async set(userId, runId, state: TaskListState) {
			await notes.save({ id: taskListNoteId(runId), userId, title: "Task list", body: JSON.stringify(state), pinned: false });
		},
	};
}
