import { describeOpenItems, obligatedOpenItems, type TaskLedger } from "@workspace/shared";
import { RESERVE_NOTE_AT } from "./run-governor.js";

/**
 * Portão de entrega (V3/V3b): `create_file` e a resposta final ficam retidos
 * enquanto há itens abertos e o orçamento ainda não chegou a 80% (o mesmo ponto
 * em que o governor A3 manda entregar). Decisão pura, sem análise de frase: o
 * sinal é estrutural (itens abertos + resposta sem chamada de tool).
 */

export const ITEM_GATE_MAX_BLOCKS = 3;
/** A partir daqui o portão libera: entrega o que tem, listando as lacunas. */
export const ITEM_GATE_RELEASE_AT = RESERVE_NOTE_AT;

export type GateEvent = "create_file" | "final_answer";

export type GateInput = {
	ledger: TaskLedger | undefined;
	event: GateEvent;
	budgetFraction: number;
	/** O Jev marcou a tarefa como de vários itens: o ledger é obrigatório. */
	requireLedger: boolean;
	/** Há tools de navegador na sessão (muda só o texto da nota). */
	browserAvailable: boolean;
	/** Ainda há tools para continuar (falso no fechamento forçado). */
	canContinue: boolean;
};

export type GateDecision =
	| { action: "allow"; declareGaps: boolean }
	| { action: "block"; kind: "items_open" | "ledger_required"; note: string };

/** Textos voltados ao modelo: neutros, em inglês. */
export function itemsOpenNote(ledger: TaskLedger, browserAvailable: boolean): string {
	const open = obligatedOpenItems(ledger);
	return [
		`${open.length} item${open.length === 1 ? " is" : "s are"} still open: ${describeOpenItems({ ...ledger, items: open })}.`,
		"Continue with the next open item using your tools.",
		...(browserAvailable ? ["Content that is visible in the browser is yours to read; do not ask the user to paste it."] : []),
		"Deliver or answer only when every item is done, or failed for a real reason (login, captcha, permission, not found).",
	].join(" ");
}

export const LEDGER_REQUIRED_NOTE =
	"This task covers several similar items. Declare them first with track_items (action set: the list, and the parent in scope), then go through them one by one before you deliver.";

/** Entrega liberada com itens abertos: dizer a verdade sobre o que falta. */
export const PARTIAL_DELIVERY_NOTE =
	"Some items are still open. Deliver what you have now and state plainly, in the result, each missing item and the real reason it is missing. Do not ask the user for content you could reach yourself.";

export function decideItemGate(input: GateInput): GateDecision {
	const { ledger } = input;
	// Herdado não tocado neste run não é obrigação (camada do ledger): não segura resposta nem arquivo.
	const open = ledger ? obligatedOpenItems(ledger) : [];
	if (!input.canContinue) return { action: "allow", declareGaps: open.length > 0 };
	if (!ledger || ledger.items.length === 0) {
		if (input.requireLedger && (ledger?.gateBlocks ?? 0) < ITEM_GATE_MAX_BLOCKS) {
			return { action: "block", kind: "ledger_required", note: LEDGER_REQUIRED_NOTE };
		}
		return { action: "allow", declareGaps: false };
	}
	// Checklist herdado e ainda não adotado é só uma oferta (camada do ledger): nunca segura resposta nem arquivo.
	if (ledger.carry === "offered" || ledger.carry === "asked") return { action: "allow", declareGaps: false };
	if (open.length === 0) return { action: "allow", declareGaps: false };
	if (input.budgetFraction >= ITEM_GATE_RELEASE_AT || ledger.gateBlocks >= ITEM_GATE_MAX_BLOCKS) {
		return { action: "allow", declareGaps: true };
	}
	return { action: "block", kind: "items_open", note: itemsOpenNote(ledger, input.browserAvailable) };
}
