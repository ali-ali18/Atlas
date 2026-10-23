import { buildPartial, currentItem, describeOpenItems, isLedgerSatisfied, obligatedOpenItems, type LedgerItem, type TaskLedger } from "@workspace/shared";

/**
 * Progress Ledger (V3b): a cada decisão de ferramenta, funções puras respondem
 * se o pedido está satisfeito, se há laço, se há progresso e qual é o próximo
 * item; a estagnação gera replanejamento e, esgotados os replans, entrega
 * parcial honesta. Nada aqui chama modelo.
 */

/** K: decisões seguidas sem progresso antes de replanejar. */
export const REPLAN_AFTER_STALLED = 3;
/** M: replanejamentos antes de encerrar com entrega parcial. */
export const MAX_REPLANS = 2;
/** Mesma ação (tool + alvo) repetida tantas vezes seguidas = laço. */
export const LOOP_REPEATS = 3;

export type StepSignal = {
	/** Tool + alvo normalizados da decisão (vazio = desconhecido). */
	actionKey: string;
	/** Novidade do ExecutionLedger; `undefined` = não medida (disciplina desligada). */
	novelty: number | undefined;
	/** Itens fechados (done/failed) nesta decisão. */
	itemsClosed: number;
};

export type ProgressVerdict = {
	satisfied: boolean;
	loop: boolean;
	progressing: boolean;
	nextItem: LedgerItem | undefined;
};

export function evaluateProgress(input: { ledger: TaskLedger; recent: readonly StepSignal[] }): ProgressVerdict {
	const { ledger, recent } = input;
	const last = recent[recent.length - 1];
	const tail = recent.slice(-LOOP_REPEATS);
	const loop =
		tail.length >= LOOP_REPEATS &&
		tail[0]!.actionKey !== "" &&
		tail.every((step) => step.actionKey === tail[0]!.actionKey);
	const closedNow = (last?.itemsClosed ?? 0) > 0;
	// Novidade não medida não pode virar estagnação falsa.
	const newContent = last ? last.novelty === undefined || last.novelty > 0 : false;
	return {
		satisfied: isLedgerSatisfied(ledger),
		loop,
		progressing: closedNow || (newContent && !loop),
		nextItem: currentItem(ledger),
	};
}

export type ReplanOutcome =
	| { action: "none"; ledger: TaskLedger }
	| { action: "replan"; ledger: TaskLedger; note: string }
	| { action: "stop"; ledger: TaskLedger; note: string };

export function replanNote(ledger: TaskLedger, k = REPLAN_AFTER_STALLED): string {
	const stuck = currentItem(ledger);
	const where = stuck ? ` The stuck item is ${stuck.id} "${stuck.label}"${stuck.scope ? ` (parent: ${stuck.scope})` : ""}.` : "";
	return `[Execution note] No progress in the last ${k} steps.${where} Update the plan: reorder or split the stuck item, or try a different route (search, another page, expand sections). Do not repeat the same action. If the list changed, rewrite it with track_items.`;
}

export function stopNote(ledger: TaskLedger): string {
	const done = ledger.items.filter((item) => item.status === "done").map((item) => item.id).join(", ") || "none";
	const missing = describeOpenItems({ ...ledger, items: ledger.items.filter((item) => item.status !== "done") }, 400);
	return `[Execution note] Stopping with a partial result. Done: ${done}. Missing: ${missing}, with the real reason for each. State this plainly in the answer, and in the file if you create one. Do not ask the user for content you can reach yourself.`;
}

/**
 * Avança o contador de estagnação. Só conta com itens abertos num ledger em uso.
 * Após K sem progresso: replaneja (até M vezes); depois, para com parcial honesta.
 */
export function advanceReplan(
	ledger: TaskLedger,
	verdict: ProgressVerdict,
	limits: { k?: number; m?: number } = {},
): ReplanOutcome {
	const k = limits.k ?? REPLAN_AFTER_STALLED;
	const m = limits.m ?? MAX_REPLANS;
	const idle = obligatedOpenItems(ledger).length === 0 || verdict.progressing;
	if (idle) return { action: "none", ledger: ledger.stalled ? { ...ledger, stalled: 0 } : ledger };
	const stalled = ledger.stalled + 1;
	if (stalled < k) return { action: "none", ledger: { ...ledger, stalled } };
	if (ledger.replans >= m) {
		const next = { ...ledger, stalled: 0, stopped: true, partial: buildPartial(ledger, "not reached: no progress after replanning") };
		return { action: "stop", ledger: next, note: stopNote(next) };
	}
	const next = { ...ledger, stalled: 0, replans: ledger.replans + 1 };
	return { action: "replan", ledger: next, note: replanNote(next, k) };
}
