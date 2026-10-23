import { applyLateRunUsage, applyReconciledCost, stepTelemetryOf, type LateRunUsage, type RunTelemetryMeta } from "@workspace/shared";
import type { Prisma } from "@prisma/client";
import { prisma } from "./client.js";

export type StepMissingCost = { stepId: string; generationId: string };

/**
 * Passos de modelo do run sem custo mas com id de geração do OpenRouter.
 * Escopado pelo dono do run (`userId`); limitado a `limit` (reconciliação
 * limitada por run).
 */
export async function listStepsMissingCost(input: {
	runId: string;
	userId: string;
	limit: number;
}): Promise<StepMissingCost[]> {
	const rows = await prisma.agentStep.findMany({
		where: { runId: input.runId, run: { userId: input.userId }, type: "model", costUsd: null },
		orderBy: { index: "asc" },
		select: { id: true, outputJson: true },
		take: 500,
	});
	const out: StepMissingCost[] = [];
	for (const row of rows) {
		const telemetry = stepTelemetryOf({ outputJson: row.outputJson });
		if ((telemetry?.provider && telemetry.provider !== "openrouter") || telemetry?.costKind === "plan") continue;
		const generationId = telemetry?.generationId;
		if (typeof generationId === "string" && generationId) {
			out.push({ stepId: row.id, generationId });
			if (out.length >= Math.max(0, input.limit)) break;
		}
	}
	return out;
}

/**
 * Grava o custo reconciliado no passo e soma no `usageJson` do run, numa
 * transação. Idempotente: só age se o passo ainda está sem custo
 * (`updateMany ... costUsd: null`), então repetir não soma duas vezes.
 * Devolve false quando nada mudou.
 */
export async function applyReconciledStepCost(input: {
	runId: string;
	userId: string;
	stepId: string;
	costUsd: number;
}): Promise<boolean> {
	if (!Number.isFinite(input.costUsd) || input.costUsd < 0) return false;
	return prisma.$transaction(async (tx) => {
		const step = await tx.agentStep.findFirst({
			where: { id: input.stepId, runId: input.runId, run: { userId: input.userId }, costUsd: null },
			select: { outputJson: true },
		});
		if (!step) return false;
		const metadata = stepTelemetryOf({ outputJson: step.outputJson });
		if ((metadata?.provider && metadata.provider !== "openrouter") || metadata?.costKind === "plan") return false;
		const base =
			step.outputJson && typeof step.outputJson === "object" && !Array.isArray(step.outputJson)
				? (step.outputJson as Record<string, unknown>)
				: {};
		const telemetry = { ...((base.telemetry as object | undefined) ?? {}), costUsd: input.costUsd, costReconciled: true };
		const claimed = await tx.agentStep.updateMany({
			where: { id: input.stepId, runId: input.runId, costUsd: null },
			data: {
				costUsd: input.costUsd,
				outputJson: { ...base, telemetry } as Prisma.InputJsonValue,
			},
		});
		if (claimed.count !== 1) return false;
		const run = await tx.agentRun.findFirst({
			where: { id: input.runId, userId: input.userId },
			select: { usageJson: true },
		});
		const usage =
			run?.usageJson && typeof run.usageJson === "object" && !Array.isArray(run.usageJson)
				? (run.usageJson as Record<string, unknown>)
				: {};
		await tx.agentRun.updateMany({
			where: { id: input.runId, userId: input.userId },
			data: {
				usageJson: applyReconciledCost(usage as { costUsd?: number; costUnknownCalls?: number }, input.costUsd) as Prisma.InputJsonValue,
			},
		});
		return true;
	});
}

/**
 * Soma no `usageJson` do run o uso que terminou depois da conclusão (checagens que só observam a
 * resposta final) e grava a telemetria nova (ex.: decisão do Jev registrada depois). Escopado pelo
 * dono do run; outro usuário ou run inexistente devolve false sem mudar nada.
 */
export async function addLateRunUsage(input: {
	runId: string;
	userId: string;
	usage: LateRunUsage | null;
	telemetry?: RunTelemetryMeta;
}): Promise<boolean> {
	if (!input.usage && !input.telemetry) return false;
	return prisma.$transaction(async (tx) => {
		const run = await tx.agentRun.findFirst({
			where: { id: input.runId, userId: input.userId },
			select: { usageJson: true },
		});
		if (!run) return false;
		const usage =
			run.usageJson && typeof run.usageJson === "object" && !Array.isArray(run.usageJson)
				? (run.usageJson as Record<string, unknown>)
				: {};
		const updated = await tx.agentRun.updateMany({
			where: { id: input.runId, userId: input.userId },
			data: { usageJson: applyLateRunUsage(usage, input.usage, input.telemetry) as Prisma.InputJsonValue },
		});
		return updated.count === 1;
	});
}
