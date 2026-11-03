import type { ChatTool } from "@workspace/llm";
import { MAX_TASK_LIST_ITEMS, isTaskListDone, normalizeTaskListInput, type TaskListItem } from "@workspace/shared";

/**
 * `update_task_list`: checklist visível de uma tarefa de vários passos (semântica de substituir a
 * lista inteira, como o TodoWrite do Claude Code). A lista mora no TaskState do run (checkpoint),
 * volta ao próximo run da mesma conversa e é reinjetada como nota a cada passo.
 */

export const UPDATE_TASK_LIST_TOOL_NAME = "update_task_list";

/**
 * O que o usuário espera receber: `document` (arquivo: relatório, estudo, planilha) ou `answer` (a resposta no chat basta).
 * Declarado pelo MODELO; o runtime não adivinha pelo texto do pedido (regra de `60-agente.md`).
 */
export type Deliverable = "document" | "answer";

export function parseDeliverable(value: unknown): Deliverable | undefined {
	return value === "document" || value === "answer" ? value : undefined;
}

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

/**
 * `update_task_list` do motor v2: a mesma tool com o campo opcional `deliverable` (o MODELO declara se o entregável é um documento).
 * Fica só no v2 porque o prefixo do v1 ("Bom dia") tem teto de tamanho e o v1 não usa o campo.
 */
export const UPDATE_TASK_LIST_TOOL_V2: ChatTool = {
	type: "function",
	function: {
		...UPDATE_TASK_LIST_TOOL.function,
		parameters: {
			type: "object",
			properties: {
				deliverable: {
					type: "string",
					enum: ["document", "answer"],
					description: "Optional, on the first call: \"document\" when the user wants a file (report, study, spreadsheet) or the result is long; \"answer\" when a chat reply is enough (including when they said no file).",
				},
				...(UPDATE_TASK_LIST_TOOL.function.parameters as { properties: Record<string, unknown> }).properties,
			},
			required: ["items"],
		},
	},
};

/**
 * Quem recebe `update_task_list`: o agente principal em runs com humano acompanhando a conversa.
 * `chat` é o usuário falando; `bot` é um bot atendendo outro bot na conversa do próprio bot,
 * visível ao dono (a doca e o cartão aparecem ali). Rotina, webhook, proativo e subagente não têm onde mostrar.
 */
export function shouldExposeTaskList(input: { origin?: string; isSubagent: boolean }): boolean {
	return !input.isSubagent && (input.origin === "chat" || input.origin === "bot");
}

/** Itens do `todo_write` (sessão de código) como lista do chat: cancelados saem; só um in_progress. */
export function devTodosToTaskList(items: ReadonlyArray<{ content: string; status: string }>): TaskListItem[] {
	const out: TaskListItem[] = [];
	let hasActive = false;
	for (const item of items) {
		if (item.status === "cancelled") continue;
		let status: TaskListItem["status"] = item.status === "completed" ? "completed" : item.status === "in_progress" ? "in_progress" : "pending";
		if (status === "in_progress") {
			if (hasActive) status = "pending";
			hasActive = true;
		}
		out.push({ content: item.content, status });
	}
	return out.slice(0, MAX_TASK_LIST_ITEMS);
}

/** Onde a lista mora: o `TaskTracker` do run. */
export type TaskListStore = {
	get(): TaskListItem[] | undefined;
	set(next: TaskListItem[] | undefined): void;
};

/** `items` é a lista final para o cartão da thread (vazia = remover o cartão). */
export function executeUpdateTaskList(args: Record<string, unknown>, ctx: { taskListStore?: TaskListStore }): { summary: string; items: TaskListItem[]; deliverable?: Deliverable } {
	const store = ctx.taskListStore;
	if (!store) throw new Error("update_task_list is not available in this run.");
	const items = normalizeTaskListInput(args.items);
	const deliverable = parseDeliverable(args.deliverable);
	// Tool honesta: valor inválido FALHA com a lista do que é aceito; nunca vira "sem declaração" em silêncio (nem muda a lista antes).
	if (args.deliverable !== undefined && args.deliverable !== null && !deliverable) {
		throw new Error(`Invalid deliverable ${JSON.stringify(args.deliverable).slice(0, 40)}. Accepted values: "document" (the user wants a file or a long report) or "answer" (a chat reply is enough). Call update_task_list again with one of them, or leave the field out. The list was not changed.`);
	}
	const declared = deliverable ? { deliverable } : {};
	if (items.length === 0) {
		store.set(undefined);
		return { summary: "Task list cleared.", items: [], ...declared };
	}
	// Item descartado some da vista do usuário (a lista é interna): se o motivo importa, o modelo o diz na própria resposta.
	const dropped = items.some((item) => item.status === "completed" && item.content.trim().toUpperCase().startsWith("DROPPED:"));
	const droppedHint = dropped ? " Discarded items are not shown to the user: if something could not be confirmed, say so briefly in your reply." : "";
	if (isTaskListDone(items)) {
		store.set(undefined);
		// A resposta pode já ter sido entregue antes de fechar a lista: não induz um segundo resumo.
		return { summary: `All ${items.length} steps completed; list closed. If you have not given the user the final result yet, give it now; if you already did, do not repeat or summarize it.${droppedHint}`, items, ...declared };
	}
	store.set(items);
	const done = items.filter((item) => item.status === "completed").length;
	// Só contexto, nunca portão: o modelo declarou um documento, então lembra de criá-lo antes da resposta final.
	const reminder = deliverable === "document" ? " You declared a document as the deliverable: remember to create it with create_file before the final answer." : "";
	return { summary: `Task list saved: ${done}/${items.length} completed. Continue with the step in progress.${reminder}${droppedHint}`, items, ...declared };
}
