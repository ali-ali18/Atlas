import { randomUUID } from "node:crypto";
import type { AgentRunJobResult, AgentRunStatus } from "@workspace/shared";

/**
 * Identidade do lease de UMA tentativa de execução (worker + job + tentativa +
 * nonce). O BullMQ é at-least-once: uma reentrega (stalled/duplicada) no mesmo
 * processo chegaria com o `leaseOwner` do processo e re-adquiriria o lease vivo,
 * rodando o run duas vezes. Com owner por tentativa, a segunda entrega vê o
 * lease vigente de outro dono e sai sem executar.
 */
export function buildRunLeaseOwner(
	workerId: string,
	job: { id?: string; attemptsMade?: number },
	nonce: string = randomUUID().slice(0, 8),
): string {
	return `${workerId}:${job.id ?? "no-job"}:${job.attemptsMade ?? 0}:${nonce}`;
}

export type LeaseAcquireDeps<L> = {
	tryAcquire: (runId: string, owner: string) => Promise<L | null>;
	getState: (runId: string) => Promise<{
		status: AgentRunStatus;
		cancelRequested: boolean;
		leaseOwner: string | null;
	} | null>;
};

/**
 * Passo 1 do processor: assume o lease ou devolve o resultado de quem já o tem.
 * Idempotência: entrega duplicada com lease vigente de outra execução não roda
 * o run, só devolve o status atual (o job duplicado termina sem efeito).
 */
export async function acquireRunLeaseOrYield<L>(
	runId: string,
	owner: string,
	deps: LeaseAcquireDeps<L>,
): Promise<
	| { kind: "acquired"; lease: L }
	| { kind: "yield"; result: AgentRunJobResult }
	| { kind: "unavailable" }
> {
	const lease = await deps.tryAcquire(runId, owner);
	if (lease) return { kind: "acquired", lease };
	const state = await deps.getState(runId);
	if (state?.cancelRequested || state?.status === "cancelled") {
		return { kind: "yield", result: { runId, status: "cancelled" } };
	}
	if (state?.leaseOwner && state.leaseOwner !== owner) {
		return { kind: "yield", result: { runId, status: state.status } };
	}
	return { kind: "unavailable" };
}
