// Eventos ao vivo de um run (SSE) aplicados ao que só existe no aparelho: a fala chegando, a lista de tarefas e os
// cartões do run. Porta enxuta de `applyLiveEvent` e dos handlers de `use-atlas-chat.ts` (web). Pura: sem React.
import type { ComputerUseEvent } from "@workspace/shared";
import type { ChatItem, ChatPhase } from "./chat-types";

export type LiveState = {
	items: ChatItem[];
	runId: string | null;
	phase: ChatPhase;
	/** O run terminou (concluído, cancelado, erro ou orçamento): a doca de tarefas some e o gravado assume. */
	ended: boolean;
	/** Parou esperando a pessoa (aprovação, login). */
	paused: boolean;
	/** Texto simples para o usuário quando o run falhou ou foi cancelado. */
	notice: string | null;
};

export function createLiveState(): LiveState {
	return { items: [], runId: null, phase: "idle", ended: false, paused: false, notice: null };
}

/** Início de um run novo: o que sobrou do anterior (cartões, falas) já foi reconciliado com o gravado. */
export function startLiveRun(state: LiveState, runId: string | null): LiveState {
	return { ...state, runId, phase: "thinking", ended: false, paused: false, notice: null };
}

function upsert(items: ChatItem[], item: ChatItem): ChatItem[] {
	const index = items.findIndex((candidate) => candidate.id === item.id);
	if (index < 0) return [...items, item];
	const next = items.slice();
	next[index] = item;
	return next;
}

export function applyRunEvent(state: LiveState, event: ComputerUseEvent): LiveState {
	switch (event.type) {
		case "run":
			return { ...state, runId: event.runId };
		case "assistant_delta": {
			const id = `cu-${event.id}`;
			const current = state.items.find((item) => item.id === id);
			const text = (current && current.kind === "assistant" ? current.text : "") + event.delta;
			return { ...state, phase: "writing", paused: false, items: upsert(state.items, { id, kind: "assistant", text, ...(state.runId ? { runId: state.runId } : {}) }) };
		}
		case "assistant_discard": {
			// O servidor refez a resposta: o rascunho sai da tela (o app não mostra rascunho revisado, como o web).
			const id = event.id ? `cu-${event.id}` : null;
			const target = id
				? state.items.find((item) => item.id === id)
				: [...state.items].reverse().find((item) => item.kind === "assistant" && item.id.startsWith("cu-"));
			if (!target) return state;
			return { ...state, items: state.items.filter((item) => item !== target) };
		}
		case "tool_intent":
		case "tool_call":
			return { ...state, phase: "tool", paused: false };
		case "task_list": {
			const runId = event.runId ?? state.runId ?? "local";
			const id = `task-list-${runId}`;
			// A lista mais recente do run substitui a anterior (nunca empilha); vazia remove.
			if (event.items.length === 0) return { ...state, items: state.items.filter((item) => item.id !== id) };
			return { ...state, items: upsert(state.items, { id, kind: "task-list", runId, items: event.items }) };
		}
		case "confirm": {
			const status = event.status === "approved" || event.status === "rejected" ? event.status : "pending";
			if (event.devApproval || event.secretsRequest || event.emailKeyRequest || event.githubIdentity) {
				return { ...state, paused: status === "pending", items: upsert(state.items, { id: `confirm-${event.confirmId}`, kind: "web-card", card: "approval", title: event.title, key: `confirm:${event.confirmId}` }) };
			}
			return {
				...state,
				paused: status === "pending",
				items: upsert(state.items, {
					id: `confirm-${event.confirmId}`,
					kind: "confirm",
					confirmId: event.confirmId,
					title: event.title,
					status,
					...(event.description ? { description: event.description } : {}),
					...(event.confirmLabel ? { confirmLabel: event.confirmLabel } : {}),
					...(event.cancelLabel ? { cancelLabel: event.cancelLabel } : {}),
				}),
			};
		}
		case "questionnaire":
			return {
				...state,
				items: upsert(state.items, {
					id: `questionnaire-${event.questionnaireId}`,
					kind: "questionnaire",
					questionnaireId: event.questionnaireId,
					title: event.title,
					items: event.items,
					status: event.status ?? "pending",
					...(event.description ? { description: event.description } : {}),
				}),
			};
		case "chart":
			return withWebCard(state, `chart-${event.chartId}`, "chart", "Gráfico", `chart:${event.chartId}`);
		case "page":
			return withWebCard(state, `page-live-${event.pageId}`, "page", event.title, `page:${event.pageId}`);
		case "file":
			return withWebCard(state, `file-${event.artifactId}`, "file", event.filename, `file:${event.artifactId}`);
		case "routine":
			if (!event.title) return state;
			return withWebCard(state, `routine-${state.runId ?? "local"}-${event.routineId ?? event.title}`, "routine", event.title, `routine:${event.routineId ?? event.title}`);
		case "login":
			return withWebCard(state, `login-${event.loginId}`, "login", `Entrar em ${event.site}`, `login:${event.loginId}`);
		case "paused":
			return { ...state, paused: true, phase: "idle" };
		case "cancelled":
			return { ...state, ended: true, paused: false, phase: "idle", notice: "Parei por aqui." };
		case "error": {
			const text = event.error.trim();
			if (!text) return { ...state, ended: true, phase: "idle" };
			return { ...state, ended: true, phase: "idle", paused: false, items: upsert(state.items, { id: "cu-run-error", kind: "assistant", text }) };
		}
		case "done":
			return { ...state, ended: true, paused: false, phase: "idle" };
		case "status":
			if (event.status === "budget_exhausted") return { ...state, ended: true, phase: "idle", notice: "Cheguei no limite desta tarefa. Posso continuar se você pedir." };
			return state;
		default:
			return state;
	}
}

function withWebCard(state: LiveState, id: string, card: Extract<ChatItem, { kind: "web-card" }>["card"], title: string, key: string): LiveState {
	if (state.items.some((item) => item.kind === "web-card" && item.key === key)) return state;
	return { ...state, items: upsert(state.items, { id, kind: "web-card", card, title, key }) };
}

/** Eventos que encerram a conexão (o run acabou ou parou esperando a pessoa). */
export function isRunBoundary(event: ComputerUseEvent): boolean {
	return event.type === "done" || event.type === "paused" || event.type === "cancelled" || event.type === "error" || (event.type === "status" && event.status === "budget_exhausted");
}

/** Estados do run no servidor que não voltam sozinhos. */
export const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled", "budget_exhausted", "paused"]);
