import { classifyFinish, type FinishReason, type TaskListItem } from "@workspace/shared";

/**
 * Empurrões estruturais do motor v3 (desenho 2.3). Só quatro, todos por SINAL ESTRUTURAL (finish reason, protocolo,
 * estado declarado pelo próprio modelo na lista de tarefas), nunca por leitura do texto. A mensagem anterior fica na
 * conversa (nada é apagado) e o empurrão vai como `user` curto com prefixo `[runtime]` (nunca `system` no meio do run).
 * Teto por tipo e teto global de 3 por run: esgotado, o turno termina com o que o modelo escreveu.
 */
export type NudgeKind = "truncated" | "empty" | "malformed" | "open_list";

export const RUNTIME_PREFIX = "[runtime]";
export const NUDGE_CAPS: Readonly<Record<NudgeKind, number>> = { truncated: 2, empty: 1, malformed: 2, open_list: 1 };
export const NUDGE_GLOBAL_CAP = 3;

export type NudgeState = Partial<Record<NudgeKind, number>>;

export function createNudges(initial?: NudgeState) {
	const used: NudgeState = { ...initial };
	const total = () => Object.values(used).reduce((sum, value) => sum + (value ?? 0), 0);
	return {
		/** Gasta um empurrão do tipo se ainda cabe nos dois tetos; `false` = o turno termina como está. */
		take(kind: NudgeKind): boolean {
			if ((used[kind] ?? 0) >= NUDGE_CAPS[kind] || total() >= NUDGE_GLOBAL_CAP) return false;
			used[kind] = (used[kind] ?? 0) + 1;
			return true;
		},
		snapshot: (): NudgeState => ({ ...used }),
	};
}

export type Nudges = ReturnType<typeof createNudges>;

const open = (items: readonly TaskListItem[] | undefined) => (items ?? []).filter((item) => item.status !== "completed");

/**
 * Sinal de uma resposta SEM tool call (a resposta com tool nunca é empurrada). `ownList` é a lista que o modelo enviou
 * por `update_task_list` NESTE run (lista herdada não conta).
 */
export function nudgeSignal(reply: { text: string; finishReason?: FinishReason }, ownList: readonly TaskListItem[] | undefined): NudgeKind | undefined {
	if (classifyFinish(reply.finishReason) === "truncated") return "truncated";
	if (reply.finishReason === "tool_calls") return "malformed";
	if (reply.text.trim().length === 0) return "empty";
	if (open(ownList).length > 0) return "open_list";
	return undefined;
}

export function nudgeText(kind: NudgeKind, ownList?: readonly TaskListItem[]): string {
	switch (kind) {
		case "truncated":
			return `${RUNTIME_PREFIX} Your reply was cut by the output limit. Continue exactly where it stopped.`;
		case "empty":
			return `${RUNTIME_PREFIX} Your last reply was empty. Answer the user or call a tool.`;
		case "malformed":
			return `${RUNTIME_PREFIX} Your last reply announced a tool call but no valid call arrived. Call the tool again with valid JSON arguments, or answer the user.`;
		case "open_list": {
			const items = open(ownList);
			const titles = items.map((item) => item.content.slice(0, 80)).slice(0, 8).join("; ");
			return `${RUNTIME_PREFIX} Your task list still has ${items.length} open items: ${titles}. Continue them, or mark each completed or DROPPED with the reason, then answer.`;
		}
	}
}
