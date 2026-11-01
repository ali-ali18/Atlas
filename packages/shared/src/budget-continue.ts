/**
 * "Continuar pesquisa (+US$ X)": card legado. O trabalho longo do v2 não para mais por dinheiro (o árbitro é progresso e tempo),
 * então o worker NÃO oferece mais este card; o código de resolução fica só para cards já gravados. Dinheiro continua sendo
 * decisão da pessoa: sem aprovação nada é gasto.
 * Tipos e funções puras compartilhados por worker (oferece), db (persiste e resolve), API (aprova) e web (card).
 */

export type BudgetContinueStatus = "pending" | "approved" | "dismissed";

/** Faixa aceita para o valor mostrado (a política do bot já limita a US$ 0,05–20). */
export const BUDGET_CONTINUE_MIN_USD = 0.01;
export const BUDGET_CONTINUE_MAX_USD = 20;

export type BudgetContinueData = {
	/** Estável por run que parou (`budgetContinueOfferId`): ao vivo e persistido são o mesmo card. */
	offerId: string;
	/** Run que parou por orçamento (de onde a continuação retoma o caderno). */
	runId: string;
	/** Quanto a continuação pode gastar, no máximo (o orçamento do bot). */
	budgetUsd: number;
	status: BudgetContinueStatus;
	/** Run de continuação criado na aprovação. */
	continuationRunId?: string;
};

export type BudgetContinueEvent = { type: "budget-continue" } & Omit<BudgetContinueData, "status"> & { status?: BudgetContinueStatus };

export type PersistedBudgetContinueCard = { v: 1; kind: "budget-continue" } & BudgetContinueData;

export const budgetContinueOfferId = (runId: string) => `continue-${runId}`;

/** Valor mostrado e gravado: arredondado a centavos, dentro da faixa; inválido = sem oferta. */
export function normalizeBudgetContinueUsd(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	const rounded = Math.round(value * 100) / 100;
	return rounded >= BUDGET_CONTINUE_MIN_USD && rounded <= BUDGET_CONTINUE_MAX_USD ? rounded : null;
}

export function buildBudgetContinueCard(input: { runId: string; budgetUsd: number }): PersistedBudgetContinueCard | null {
	const budgetUsd = normalizeBudgetContinueUsd(input.budgetUsd);
	if (!budgetUsd || !input.runId.trim()) return null;
	return { v: 1, kind: "budget-continue", offerId: budgetContinueOfferId(input.runId), runId: input.runId, budgetUsd, status: "pending" };
}

export function parseBudgetContinue(raw: unknown): BudgetContinueData | null {
	if (!raw || typeof raw !== "object") return null;
	const row = raw as Record<string, unknown>;
	const offerId = typeof row.offerId === "string" ? row.offerId.trim() : "";
	const runId = typeof row.runId === "string" ? row.runId.trim() : "";
	const budgetUsd = normalizeBudgetContinueUsd(row.budgetUsd);
	if (!offerId || offerId.length > 160 || !runId || runId.length > 160 || !budgetUsd) return null;
	const status: BudgetContinueStatus = row.status === "approved" || row.status === "dismissed" ? row.status : "pending";
	const continuationRunId = typeof row.continuationRunId === "string" && row.continuationRunId.trim() && row.continuationRunId.length <= 160 ? row.continuationRunId.trim() : undefined;
	return { offerId, runId, budgetUsd, status, ...(continuationRunId ? { continuationRunId } : {}) };
}

export function parseBudgetContinueCard(raw: unknown): PersistedBudgetContinueCard | null {
	if (!raw || typeof raw !== "object") return null;
	const row = raw as Record<string, unknown>;
	if (row.v !== 1 || row.kind !== "budget-continue") return null;
	const data = parseBudgetContinue(row);
	return data ? { v: 1, kind: "budget-continue", ...data } : null;
}

/** Instrução (inglês, vai ao modelo) do run de continuação: retoma do caderno e da lista, sem refazer. */
export const BUDGET_CONTINUE_INSTRUCTION =
	"The user approved more budget to continue the previous long task. Continue from where it stopped: read the task notebook and the task list first, do not redo what is already done, close the open items and the ones marked unconfirmed, and deliver the complete result (the document when one was asked).";

/**
 * O run é uma continuação que o dono APROVOU pelo card? Marca `approvedContinuation` no `budgetJson`, gravada só pelo
 * caminho de aprovação no db (a API nunca copia essa chave do corpo: `parseBudgetBody` só aceita campos conhecidos).
 * Dono aprovando = o orçamento do card vence o teto da conta, em custo e em tempo.
 */
export function readApprovedContinuation(budgetJson: unknown): boolean {
	const budget = budgetJson as { approvedContinuation?: unknown; continuationOf?: unknown } | null | undefined;
	return budget?.approvedContinuation === true && typeof budget.continuationOf === "string" && budget.continuationOf.trim().length > 0;
}

/** Dica ao worker: a continuação nasce do run que parou; o caderno dele é copiado para o novo (mesmo dono). */
export function readContinuationSource(budgetJson: unknown): string | undefined {
	const value = (budgetJson as { continuationOf?: unknown } | null | undefined)?.continuationOf;
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
