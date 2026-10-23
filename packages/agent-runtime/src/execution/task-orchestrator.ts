import { buildPartial, createTaskLedger, markItemsCarried, obligatedOpenItems, openItems, parseTaskLedger, renderLedgerLayer, type TaskLedger } from "@workspace/shared";
import type { LedgerStore } from "../tools/track-items.js";
import { ITEM_GATE_MAX_BLOCKS, ITEM_GATE_RELEASE_AT, PARTIAL_DELIVERY_NOTE, decideItemGate, type GateDecision, type GateEvent } from "./item-gate.js";
import { advanceReplan, evaluateProgress, type StepSignal } from "./progress-ledger.js";
import type { TaskTracker } from "./task-state.js";

/**
 * Orquestrador da tarefa (V3b): junta o Task Ledger (no `TaskState`), o portão
 * de entrega e o Progress Ledger. O loop só chama `layer`, `gate`, `endDecision`
 * e `gapsNote`; as decisões vêm das funções puras de `item-gate` e
 * `progress-ledger`.
 */

/** Dica (neutra, em inglês) no início de uma tarefa que o Jev marcou como de vários itens. */
export const MULTI_ITEM_START_NOTE =
	"This request covers several similar items. Start by declaring them with track_items (action set: one item per section, row or page, with its parent in scope), then go through them one by one.";

/** Decisões que só mexem em anotações: não contam como progresso nem como estagnação. */
const BOOKKEEPING_TOOLS = new Set(["track_items", "research_note", "update_task_list"]);
export const isBookkeepingOnly = (toolNames: readonly string[]) =>
	toolNames.length > 0 && toolNames.every((name) => BOOKKEEPING_TOOLS.has(name));

const RECENT_STEPS = 6;
const closedCount = (ledger: TaskLedger | undefined) =>
	ledger ? ledger.items.filter((item) => item.status === "done" || item.status === "failed").length : 0;

export type GateContext = { budgetFraction: number; canContinue: boolean; browserAvailable: boolean };

export function createTaskOrchestrator(options: {
	tracker: TaskTracker;
	/** Ledger de runs anteriores da mesma conversa (já escopado por dono no carregamento). */
	prior?: unknown;
	/** O Jev viu uma tarefa de vários itens: o ledger é obrigatório antes de entregar. */
	requireLedger: () => boolean;
}) {
	const { tracker } = options;
	// Herança entre runs: itens abertos da conversa viram uma oferta, não uma obrigação, até o modelo adotá-los.
	if (!tracker.ledger()) {
		const prior = parseTaskLedger(options.prior);
		if (prior && openItems(prior).length > 0) {
			const { partial: _partial, stopped: _stopped, ...rest } = prior;
			tracker.setLedger(markItemsCarried({ ...rest, stalled: 0, replans: 0, gateBlocks: 0, answerBlocks: 0, carry: "offered" }));
		}
	}
	let recent: StepSignal[] = [];
	let closedBefore = closedCount(tracker.ledger());

	const store: LedgerStore = {
		get: () => tracker.ledger(),
		set: (next) => tracker.setLedger(next),
	};
	const bump = (patch: (ledger: TaskLedger) => TaskLedger, base?: TaskLedger) => {
		const ledger = patch(base ?? tracker.ledger() ?? createTaskLedger());
		tracker.setLedger(ledger);
		return ledger;
	};

	return {
		store,
		ledger: () => tracker.ledger(),
		/** Camada efêmera por passo (<= 600 chars). Null sem itens. */
		layer(): string | null {
			const ledger = tracker.ledger();
			return ledger ? renderLedgerLayer(ledger) : null;
		},
		hasOpenItems(): boolean {
			const ledger = tracker.ledger();
			return Boolean(ledger && obligatedOpenItems(ledger).length > 0);
		},
		/** Portão de `create_file` e da resposta final. Conta a interceptação e grava a parcial declarada. */
		gate(event: GateEvent, context: GateContext): GateDecision {
			const ledger = tracker.ledger();
			const decision = decideItemGate({ ledger, event, requireLedger: options.requireLedger(), ...context });
			if (decision.action === "block") {
				bump(
					(current) => ({
						...current,
						gateBlocks: current.gateBlocks + 1,
						...(event === "final_answer" ? { answerBlocks: (current.answerBlocks ?? 0) + 1 } : {}),
					}),
					ledger,
				);
			} else if (decision.declareGaps && ledger && !ledger.partial) {
				bump((current) => ({ ...current, partial: buildPartial(current, "not reached before delivery") }), ledger);
			}
			return decision;
		},
		/** Há lacuna declarável neste run: item obrigatório aberto ou item que falhou. */
		hasGaps(): boolean {
			const ledger = tracker.ledger();
			return Boolean(ledger && (obligatedOpenItems(ledger).length > 0 || ledger.items.some((item) => item.status === "failed")));
		},
		/** O portão já refez a resposta final neste run (a próxima sai como está). */
		answerRevised(): boolean {
			return (tracker.ledger()?.answerBlocks ?? 0) > 0;
		},
		/** Entrega liberada com itens abertos (orçamento >= 80% ou 3 interceptações): pede a verdade sobre as lacunas. */
		gapsNote(budgetFraction: number): string | null {
			const ledger = tracker.ledger();
			if (!ledger || obligatedOpenItems(ledger).length === 0) return null;
			return budgetFraction >= ITEM_GATE_RELEASE_AT || ledger.gateBlocks >= ITEM_GATE_MAX_BLOCKS ? PARTIAL_DELIVERY_NOTE : null;
		},
		/** Depois de M replans e K passos sem progresso: fecha com a entrega parcial (sem mais tools). */
		stopRequested(): boolean {
			const ledger = tracker.ledger();
			return Boolean(ledger?.stopped && obligatedOpenItems(ledger).length > 0);
		},
		/** Fecha uma decisão de ferramenta; devolve o aviso de replanejamento/parcial, se for a hora. */
		endDecision(input: { actionKey: string; novelty: number | undefined; bookkeepingOnly: boolean }): { note: string | null; stop: boolean } {
			const ledger = tracker.ledger();
			if (!ledger || ledger.items.length === 0) {
				closedBefore = closedCount(ledger);
				return { note: null, stop: false };
			}
			const closed = closedCount(ledger);
			const itemsClosed = Math.max(0, closed - closedBefore);
			closedBefore = closed;
			if (input.bookkeepingOnly && itemsClosed === 0) return { note: null, stop: false };
			recent = [...recent, { actionKey: input.actionKey, novelty: input.novelty, itemsClosed }].slice(-RECENT_STEPS);
			if (ledger.stopped) return { note: null, stop: false };
			const outcome = advanceReplan(ledger, evaluateProgress({ ledger, recent }));
			tracker.setLedger(outcome.ledger);
			if (outcome.action === "none") return { note: null, stop: false };
			recent = [];
			return { note: outcome.note, stop: outcome.action === "stop" };
		},
	};
}

export type TaskOrchestrator = ReturnType<typeof createTaskOrchestrator>;
