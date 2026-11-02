import type { AgentRunStatus } from "@workspace/shared";
import type { TaskItem } from "./chat-types";

// Lista de Execuções do bot: cada execução é um run com cartão de tarefas no chat. O título sai da primeira tarefa do
// cartão e o estado, do status do run. Lógica pura (sem rede e sem relógio), só pt-BR.

export type ExecutionState = "running" | "waiting" | "done" | "error" | "stopped";

export type ExecutionEntry = { runId: string; title: string; state: ExecutionState | null; at: string };

/** Estado do run em uma palavra para o usuário. `budget_exhausted` é "Parado": o bot parou por limite, não por defeito. */
export function executionState(status: AgentRunStatus): ExecutionState {
	switch (status) {
		case "completed":
			return "done";
		case "failed":
			return "error";
		case "cancelled":
		case "budget_exhausted":
			return "stopped";
		case "paused":
		case "waiting_user":
		case "waiting_external":
			return "waiting";
		default:
			return "running";
	}
}

const STATE_LABEL: Record<ExecutionState, string> = { running: "Em andamento", waiting: "Esperando você", done: "Concluído", error: "Erro", stopped: "Parado" };
export const executionStateLabel = (state: ExecutionState): string => STATE_LABEL[state];

export type TaskCardRef = { runId: string; items: readonly TaskItem[]; createdAt: string };
export type RunRef = { id: string; status: AgentRunStatus; createdAt: string };

/** Título da execução: a primeira tarefa do plano (sem plano, "Execução de dd/mm hh:mm" no fuso do aparelho). */
export function executionTitle(items: readonly TaskItem[], at: string): string {
	const first = items.find((item) => item.content.trim())?.content.trim();
	if (first) return first;
	const date = new Date(at);
	if (Number.isNaN(date.getTime())) return "Execução";
	const pad = (value: number) => String(value).padStart(2, "0");
	return `Execução de ${pad(date.getDate())}/${pad(date.getMonth() + 1)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Junta os cartões de tarefas (um por run) com o estado dos runs da conversa. Mais nova primeiro. Run fora da lista de
 * estados (mais antigo que os 20 que o servidor devolve) fica sem estado: melhor não dizer nada que dizer errado.
 */
export function buildExecutions(cards: readonly TaskCardRef[], runs: readonly RunRef[]): ExecutionEntry[] {
	const byId = new Map(runs.map((run) => [run.id, run] as const));
	const seen = new Set<string>();
	const entries: ExecutionEntry[] = [];
	for (const card of cards) {
		if (seen.has(card.runId)) continue;
		seen.add(card.runId);
		const run = byId.get(card.runId);
		const at = run?.createdAt ?? card.createdAt;
		entries.push({ runId: card.runId, title: executionTitle(card.items, at), state: run ? executionState(run.status) : null, at });
	}
	return entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}
