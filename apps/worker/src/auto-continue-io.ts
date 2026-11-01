import {
	countCompletedToolResults,
	createFollowUpRun,
	createRunInput,
	listPendingQueueInputs,
	listPendingSteerInputs,
	readRunContextLength,
} from "@workspace/db";
import { readRunReasoningEffort } from "@workspace/shared";
import { chainFollowUp, followUpRequest } from "./follow-up.js";
import { continuationBudget, type AutoContinueIo } from "./auto-continue.js";

/** Enfileira o run de continuação (com espera opcional); `false` = falhou e a reconciliação repete. */
export type EnqueueWithDelay = (runId: string, options?: { delayMs?: number }) => Promise<boolean>;

/** Ligação real da retomada automática com o banco e a fila (os testes usam IO falso). */
export function createAutoContinueIo(enqueue: EnqueueWithDelay | undefined): AutoContinueIo {
	return {
		hasPendingInput: async (runId) => (await listPendingQueueInputs(runId)).length + (await listPendingSteerInputs(runId)).length > 0,
		countProgress: countCompletedToolResults,
		addInput: async (runId, userId, content, clientKey) => {
			await createRunInput(runId, { content, mode: "queue", author: "agent", clientKey, silent: true }, userId);
		},
		chain: (run, userId, decision) =>
			chainFollowUp({
				listQueued: () => listPendingQueueInputs(run.id),
				listSteers: () => listPendingSteerInputs(run.id),
				createFollowUp: (plan) =>
					createFollowUpRun({
						parentRunId: run.id,
						userId,
						model: run.model,
						contextLength: readRunContextLength(run),
						request: followUpRequest(
							{
								model: run.model,
								conversationId: run.conversationId ?? undefined,
								botId: run.botId ?? undefined,
								origin: run.origin as "chat" | "routine" | "webhook" | "bot" | "proactive",
								budget: continuationBudget(decision),
								reasoningEffort: readRunReasoningEffort(run.budgetJson),
							},
							plan,
						),
						consume: plan.consume,
						defer: plan.defer,
						// Continuação do mesmo trabalho: segue como turno do dono, no mesmo motor e perfil (sem cair no teto da conta).
						inheritFromParent: true,
					}),
				enqueueNextRun: enqueue ? (nextRunId) => enqueue(nextRunId, { delayMs: decision.delayMs }) : undefined,
				announce: async () => undefined,
			}),
	};
}
