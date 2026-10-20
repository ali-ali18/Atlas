/**
 * Lista de passos da conversa (`update_task_list`): checklist curta e visível que o modelo
 * mantém em tarefas de vários passos. Funções puras; o armazenamento é o TaskState do run
 * (checkpoint) e a lista volta ao run seguinte da mesma conversa enquanto houver passo aberto.
 */

export type TaskListStatus = "pending" | "in_progress" | "completed";

export type TaskListItem = { content: string; status: TaskListStatus };

export const MAX_TASK_LIST_ITEMS = 20;
export const MAX_TASK_LIST_CONTENT_CHARS = 160;

const STATUSES: readonly TaskListStatus[] = ["pending", "in_progress", "completed"];

/** Valida o que o modelo enviou (substitui a lista inteira). Erros em inglês, para o modelo corrigir. */
export function normalizeTaskListInput(value: unknown): TaskListItem[] {
	if (!Array.isArray(value)) throw new Error("items must be a list of { content, status }.");
	if (value.length > MAX_TASK_LIST_ITEMS) throw new Error(`Too many items (max ${MAX_TASK_LIST_ITEMS}). Merge or drop steps.`);
	const items: TaskListItem[] = [];
	value.forEach((entry, index) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`items[${index}] must be an object { content, status }.`);
		const raw = entry as Record<string, unknown>;
		const content = typeof raw.content === "string" ? raw.content.replace(/\s+/g, " ").trim() : "";
		if (!content) throw new Error(`items[${index}].content must be a non-empty string.`);
		const status = STATUSES.find((item) => item === raw.status);
		if (!status) throw new Error(`items[${index}].status must be one of: ${STATUSES.join(", ")}.`);
		items.push({ content: content.slice(0, MAX_TASK_LIST_CONTENT_CHARS), status });
	});
	if (items.filter((item) => item.status === "in_progress").length > 1) {
		throw new Error("At most one item can be in_progress at a time.");
	}
	return items;
}

/** Leitura tolerante do checkpoint: ignora o que não é item válido. */
export function parseTaskList(raw: unknown): TaskListItem[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const items: TaskListItem[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") continue;
		const { content, status } = entry as Record<string, unknown>;
		const parsedStatus = STATUSES.find((item) => item === status);
		if (typeof content !== "string" || !content.trim() || !parsedStatus) continue;
		items.push({ content: content.trim().slice(0, MAX_TASK_LIST_CONTENT_CHARS), status: parsedStatus });
	}
	return items.length > 0 ? items.slice(0, MAX_TASK_LIST_ITEMS) : undefined;
}

export function isTaskListDone(items: readonly TaskListItem[]): boolean {
	return items.length > 0 && items.every((item) => item.status === "completed");
}

/** Nota por turno para o modelo; `null` sem lista ou com tudo concluído. */
export function renderTaskListNote(items: readonly TaskListItem[] | undefined): string | null {
	if (!items || items.length === 0 || isTaskListDone(items)) return null;
	const marks: Record<TaskListStatus, string> = { pending: "[ ]", in_progress: "[>]", completed: "[x]" };
	const lines = items.map((item, index) => `${index + 1}. ${marks[item.status]} ${item.content}`);
	return [
		"Current task list (kept with update_task_list; [x] done, [>] in progress, [ ] pending):",
		...lines,
		"Keep working through it: mark each step completed as soon as it is done and start the next. If the user changed the request, rewrite or clear the list.",
	].join("\n");
}
