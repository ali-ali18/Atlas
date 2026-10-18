/**
 * F0 — lê a telemetria de UM run e imprime o resumo (totais, P50/P95 por
 * categoria). Ferramenta de operador/dev local: lê por runId sem escopo de
 * usuário, então NÃO expor via API. Imprime só números e categorias; do
 * outputJson dos passos extrai apenas o campo `telemetry`.
 *
 * Uso (a partir de apps/worker, que tem o tsx):
 *   cd apps/worker && pnpm exec tsx ../../packages/db/scripts/run-telemetry.ts <runId>
 */
import { formatCostLabel, summarizeRunTelemetry, stepTelemetryOf } from "@workspace/shared";
import { prisma } from "../src/client.js";

async function main(): Promise<void> {
	const runId = process.argv[2];
	if (!runId) {
		console.error("uso: run-telemetry.ts <runId>");
		process.exitCode = 1;
		return;
	}
	try {
		const run = await prisma.agentRun.findUnique({
			where: { id: runId },
			select: { status: true, usageJson: true, startedAt: true, finishedAt: true },
		});
		if (!run) {
			console.error("run não encontrado");
			process.exitCode = 1;
			return;
		}
		const rows = await prisma.agentStep.findMany({
			where: { runId },
			orderBy: { index: "asc" },
			select: { type: true, durationMs: true, attempts: true, outputJson: true },
		});
		// Só o campo `telemetry` sai do outputJson (que pode ter conteúdo).
		const steps = rows.map((row) => ({
			type: row.type,
			durationMs: row.durationMs,
			outputJson: { telemetry: stepTelemetryOf(row) ?? undefined },
		}));
		const usage = (run.usageJson ?? {}) as { telemetry?: unknown; costUsd?: number; costUnknownCalls?: number };
		const summary = summarizeRunTelemetry(steps);
		const wallMs =
			run.startedAt && run.finishedAt
				? run.finishedAt.getTime() - run.startedAt.getTime()
				: null;
		console.log(
			JSON.stringify(
				{
					runId,
					status: run.status,
					wallMs,
					stepRetries: rows.reduce((sum, row) => sum + Math.max(0, row.attempts - 1), 0),
					run: usage.telemetry ?? null,
					// Nunca mostra o custo parcial como total.
					custo: formatCostLabel(
						usage.costUsd ?? summary.costUsd,
						usage.costUnknownCalls ?? summary.costUnknownSteps,
					),
					summary,
				},
				null,
				2,
			),
		);
	} finally {
		await prisma.$disconnect();
	}
}

void main();
