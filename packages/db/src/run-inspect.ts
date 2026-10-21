import type { InspectRawApproval, InspectRawEvent, InspectRawStep } from "@workspace/shared";
import { prisma } from "./client.js";

/** Tetos de leitura: o inspetor mostra o que cabe numa tela, não o histórico inteiro. */
export const INSPECT_MAX_STEPS = 2_000;
export const INSPECT_MAX_EVENTS = 100;
export const INSPECT_MAX_APPROVALS = 100;

export type RunInspectionData = {
	run: { id: string; status: string; model: string; origin: string; error: string | null };
	steps: InspectRawStep[];
	events: InspectRawEvent[];
	approvals: InspectRawApproval[];
};

/**
 * Linhas cruas do inspetor do run. Só o dono: outro usuário (ou inexistente) recebe `null`.
 * Reaproveita os passos (telemetria + `outputJson.inspect`), os eventos `inspect_context`/`error` e os
 * cartões de aprovação gravados pelo run; nada de armazenamento novo.
 */
export async function getRunInspectionData(runId: string, userId: string): Promise<RunInspectionData | null> {
	if (!userId.trim() || userId === "default") return null;
	const run = await prisma.agentRun.findFirst({ where: { id: runId, userId } });
	if (!run) return null;
	const [steps, events, approvals] = await Promise.all([
		prisma.agentStep.findMany({ where: { runId }, orderBy: { index: "asc" }, take: INSPECT_MAX_STEPS }),
		prisma.runEvent.findMany({ where: { runId, type: { in: ["inspect_context", "inspect_lessons", "inspect_hooks", "error"] } }, orderBy: { seq: "asc" }, take: INSPECT_MAX_EVENTS }),
		run.conversationId
			? prisma.conversationMessage.findMany({ where: { conversationId: run.conversationId, runId, role: "confirm" }, orderBy: { createdAt: "asc" }, take: INSPECT_MAX_APPROVALS, select: { id: true, content: true } })
			: Promise.resolve([] as Array<{ id: string; content: string }>),
	]);
	return {
		run: { id: run.id, status: run.status, model: run.model, origin: run.origin, error: run.error },
		steps: steps.map((row) => ({
			index: row.index,
			decisionIndex: row.decisionIndex,
			subIndex: row.subIndex,
			type: row.type,
			status: row.status,
			inputJson: row.inputJson,
			outputJson: row.outputJson,
			tokens: row.tokens,
			costUsd: row.costUsd,
			durationMs: row.durationMs,
			idempotencyKey: row.idempotencyKey,
		})),
		events: events.map((row) => ({ seq: row.seq, type: row.type, payload: row.payload, createdAt: row.createdAt.toISOString() })),
		approvals,
	};
}

/** Chamadas de ferramenta que terminaram bem no run: sinal de progresso para a retomada automática. */
export async function countCompletedToolResults(runId: string): Promise<number> {
	return prisma.agentStep.count({ where: { runId, type: "tool_result", status: "completed" } });
}

/** Chamadas de ferramenta que falharam no run (sinal de aprendizado para a revisão de lições). */
export async function countFailedToolResults(runId: string): Promise<number> {
	return prisma.agentStep.count({ where: { runId, type: "tool_result", status: "failed" } });
}
