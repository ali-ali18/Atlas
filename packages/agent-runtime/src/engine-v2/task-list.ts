/**
 * Motor v2: lista de tarefas obrigatória em trabalho longo (ADR 0002, princípio 3). Puro.
 *
 * Reaproveita o `update_task_list` e o `TaskListItem` do v1 (a lista visível na doca do chat). Item descartado
 * continua sendo `completed`, mas com o conteúdo `DROPPED: <motivo>`: assim o contrato do cartão, do checkpoint e
 * do validador não muda. Quem decide se o modelo pode entregar é este portão, não o humor do modelo.
 */
import type { BotLanguage, TaskListItem } from "@workspace/shared";

export const DROPPED_PREFIX = "DROPPED:";
/** Quantas vezes o portão devolve nota antes de deixar o modelo sair (e marcar no stop). */
export const MAX_TASK_GATE_NOTES = 2;

export function isDroppedItem(item: TaskListItem): boolean {
	return item.status === "completed" && item.content.trim().toUpperCase().startsWith(DROPPED_PREFIX);
}

export function droppedReason(item: TaskListItem): string {
	return item.content.trim().slice(DROPPED_PREFIX.length).trim() || item.content.trim();
}

export function openItems(items: readonly TaskListItem[] | undefined): TaskListItem[] {
	return (items ?? []).filter((item) => item.status !== "completed");
}

export function droppedItems(items: readonly TaskListItem[] | undefined): string[] {
	return (items ?? []).filter(isDroppedItem).map(droppedReason);
}

export type TaskGateVerdict =
	| { kind: "ok" }
	| { kind: "note"; text: string }
	/** Saiu com pendências: o texto final lista o que não foi confirmado e o stop leva `tasklist_open`. */
	| { kind: "release"; unresolved: string[] };

export function createTaskListGate(config: { required: boolean; maxNotes?: number }) {
	const maxNotes = config.maxNotes ?? MAX_TASK_GATE_NOTES;
	let notes = 0;
	return {
		get notes() {
			return notes;
		},
		/**
		 * O modelo respondeu sem chamar tool. `current` é a lista em vigor (ou a última, já fechada);
		 * `undefined` = nunca houve lista neste run.
		 */
		check(current: readonly TaskListItem[] | undefined): TaskGateVerdict {
			if (!config.required) return { kind: "ok" };
			const open = openItems(current);
			if (current && current.length > 0 && open.length === 0) return { kind: "ok" };
			if (notes >= maxNotes) return { kind: "release", unresolved: open.map((item) => item.content) };
			notes += 1;
			if (!current || current.length === 0) {
				return {
					kind: "note",
					text:
						"Task list required: this is a long task. Before delivering, call update_task_list with the steps you did or still need to do, " +
						"then complete each step or discard it with a reason (mark it completed with content \"DROPPED: <reason>\"). Then deliver the final answer.",
				};
			}
			const lines = open.map((item, index) => `${index + 1}. ${item.content}`).join("\n");
			return {
				kind: "note",
				text:
					`Task list still has open items:\n${lines}\n` +
					"Finish each one, or discard it with a reason by calling update_task_list with that item completed and its content set to \"DROPPED: <reason>\". Deliver the final answer only after every item is done or discarded.",
			};
		},
	};
}

export type TaskGate = ReturnType<typeof createTaskListGate>;

const UNCONFIRMED_LABEL: Partial<Record<BotLanguage, string>> & { default: string } = {
	"pt-BR": "Não deu para confirmar",
	"es-ES": "No se pudo confirmar",
	default: "Could not confirm",
};

/** Itens descartados e pendências aparecem na resposta, nas palavras do usuário. */
export function appendUnconfirmed(text: string, input: { dropped: readonly string[]; unresolved: readonly string[]; language: BotLanguage }): string {
	const reasons = [...input.dropped, ...input.unresolved.map((item) => item)];
	if (reasons.length === 0) return text;
	const label = UNCONFIRMED_LABEL[input.language] ?? UNCONFIRMED_LABEL.default;
	const lines = reasons.map((reason) => `- ${label}: ${reason}`).join("\n");
	return `${text.trimEnd()}\n\n${lines}`;
}
