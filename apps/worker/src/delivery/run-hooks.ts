import { parseDeliverAt, summarizeDeliveryText, type DeliveryOutcome } from "@workspace/shared";

/** Ligações do run com o backlog de entrega (injetáveis para teste). */

export type AwayNoteDeps = {
	userId: string;
	runId: string;
	conversationId: string | null | undefined;
	record: (input: { userId: string; runId: string; conversationId: string; deliverAfter: Date | null }) => Promise<boolean>;
	now?: () => Date;
};

/** Callback da triagem: guarda a nota de ausência (com o horário combinado, se válido). */
export function createAwayNoteHandler(deps: AwayNoteDeps): ((note: { deliverAt: string }) => Promise<void>) | undefined {
	if (!deps.conversationId) return undefined;
	const conversationId = deps.conversationId;
	return async (note) => {
		const now = (deps.now ?? (() => new Date()))();
		await deps.record({
			userId: deps.userId,
			runId: deps.runId,
			conversationId,
			deliverAfter: parseDeliverAt(note.deliverAt, now),
		});
	};
}

export type RunEnd = "completed" | "budget_exhausted" | "failed" | "cancelled";

/** Fim do run: com nota de ausência, o resultado entra no backlog (cancelado = descartado). Nunca lança. */
export async function settleRunDelivery(
	input: { userId: string; runId: string; end: RunEnd; resultText?: string | null },
	deps: {
		markReady: (input: { userId: string; runId: string; outcome: DeliveryOutcome; summary: string }) => Promise<boolean>;
		cancel: (input: { userId: string; runId: string }) => Promise<void>;
	},
): Promise<void> {
	try {
		if (input.end === "cancelled") {
			await deps.cancel({ userId: input.userId, runId: input.runId });
			return;
		}
		await deps.markReady({
			userId: input.userId,
			runId: input.runId,
			outcome: input.end,
			summary: summarizeDeliveryText(input.resultText),
		});
	} catch (error) {
		console.error(`[delivery] backlog do run ${input.runId} não atualizado`, error instanceof Error ? error.message : "erro");
	}
}
