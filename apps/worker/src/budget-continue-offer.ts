import { LONG_WORK_DEFAULT_BUDGET_USD, shouldOfferBudgetContinue, type BudgetContinueEvent, type PersistedBudgetContinueCard, type RunStop } from "@workspace/shared";
import type { EngineChoice } from "./engine-choice.js";

export type BudgetContinueOfferIo = {
	/** Grava o card na conversa do dono (db `offerBudgetContinue`); `null` = já existia ou não coube. */
	offer: (input: { userId: string; conversationId: string; runId: string; budgetUsd: number }) => Promise<PersistedBudgetContinueCard | null>;
	emit: (event: BudgetContinueEvent) => Promise<unknown>;
};

/** Quanto a continuação pode gastar: o orçamento do bot, nunca acima do teto que valeu neste run. */
export function continuationBudgetUsd(choice: Pick<EngineChoice, "longWorkBudgetUsd">, effectiveCostCap: number | undefined): number {
	const botBudget = choice.longWorkBudgetUsd ?? LONG_WORK_DEFAULT_BUDGET_USD;
	return effectiveCostCap !== undefined && effectiveCostCap > 0 ? Math.min(botBudget, effectiveCostCap) : botBudget;
}

/**
 * Trabalho longo do v2 que parou por custo ou tempo: oferece "Continuar pesquisa (+US$ X)". Só oferece; quem gasta
 * mais é a pessoa, ao aprovar o card (API). Falha ao gravar nunca derruba o fim do run.
 */
export async function offerContinueAfterBudgetStop(
	input: {
		choice: Pick<EngineChoice, "engine" | "profile" | "longWorkBudgetUsd">;
		run: { id: string; origin: string; conversationId: string | null };
		userId: string;
		stop: RunStop | undefined;
		effectiveCostCap: number | undefined;
	},
	io: BudgetContinueOfferIo,
): Promise<boolean> {
	const { choice, run } = input;
	if (!run.conversationId || !shouldOfferBudgetContinue({ engine: choice.engine, profile: choice.profile, origin: run.origin, hasConversation: true, stop: input.stop })) return false;
	try {
		const card = await io.offer({ userId: input.userId, conversationId: run.conversationId, runId: run.id, budgetUsd: continuationBudgetUsd(choice, input.effectiveCostCap) });
		if (!card) return false;
		await io.emit({ type: "budget-continue", offerId: card.offerId, runId: card.runId, budgetUsd: card.budgetUsd, status: "pending" });
		return true;
	} catch (error) {
		console.error(`budget continue offer failed run=${run.id}`, error instanceof Error ? error.message : "erro desconhecido");
		return false;
	}
}
