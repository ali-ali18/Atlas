import type { Message } from "@/components/ui/templates/template-4/data";

export type TaskItem = { content: string; status: "pending" | "in_progress" | "completed" };
type TaskListMessage = Extract<Message, { kind: "task-list" }>;

export function taskListProgress(items: readonly TaskItem[]) {
	const total = items.length;
	const done = items.filter((item) => item.status === "completed").length;
	// Em andamento primeiro; sem nenhuma, a próxima pendente.
	const current = items.find((item) => item.status === "in_progress") ?? items.find((item) => item.status === "pending");
	return { total, done, allDone: total > 0 && done === total, current };
}

/** Linha recolhida da doca: "2/5 · Montar a planilha" (concluída: "5/5 · Tudo pronto"). */
export function taskListDockLine(items: readonly TaskItem[]): string {
	const { total, done, allDone, current } = taskListProgress(items);
	return `${done}/${total} · ${allDone ? "Tudo pronto" : (current?.content ?? "")}`.replace(/ · $/, "");
}

/** Linha que fica na conversa depois do run: "Tarefas · 5/5 concluídas" (parou no meio: "Tarefas · 3/5"). */
export function taskListSettledLabel(items: readonly TaskItem[]): string {
	const { total, done, allDone } = taskListProgress(items);
	return allDone ? `Tarefas · ${done}/${total} concluídas` : `Tarefas · ${done}/${total}`;
}

/**
 * Lista de tarefas do run em andamento: a última `task-list` depois da última mensagem da pessoa, só enquanto
 * o run está ativo. Essa lista vive na doca do composer e não aparece no fio; sem run ativo, volta ao fio como resumo.
 */
export function dockedTaskList(messages: readonly Message[], runActive: boolean): TaskListMessage | null {
	if (!runActive) return null;
	let lastUser = -1;
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index]!.kind === "user") {
			lastUser = index;
			break;
		}
	}
	for (let index = messages.length - 1; index > lastUser; index--) {
		const message = messages[index]!;
		if (message.kind === "task-list" && message.items.length > 0) return message;
	}
	return null;
}
