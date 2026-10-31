import { AgentRunLoopDetectedError, BudgetExhaustedError, type ClassifiedRunError } from "@workspace/agent-runtime";
import { stopReasonOfBudget, stopReasonOfLoop, type RunStop } from "@workspace/shared";

/** Motivo de término de um run que parou por orçamento. `autoContinue`: o worker agendou a retomada sozinho. */
export function stopOfBudgetError(error: BudgetExhaustedError, autoContinue: boolean): RunStop {
	return { reason: stopReasonOfBudget(error.kind), ...(autoContinue ? { detail: "auto_continue" } : {}) };
}

/** Motivo de término de um run que falhou de vez (erro permanente, trava de loop ou espera pelo usuário). */
export function stopOfFailure(error: unknown, kind: ClassifiedRunError): RunStop {
	if (kind === "waiting_user") return { reason: "awaiting_confirmation", detail: "waiting_user" };
	if (error instanceof AgentRunLoopDetectedError) return { reason: stopReasonOfLoop(error.kind) };
	return { reason: "error", detail: kind };
}
