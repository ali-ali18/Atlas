import { COMPOSIO_CATALOG_ID, scrubString, shortReason, type DiagnosticsFailure } from "@workspace/shared";
import { prisma } from "./client.js";

/**
 * Leituras para o Diagnóstico (só do dono, sempre escopadas pelo usuário). Os motivos passam
 * pelo scrub e saem em uma linha curta.
 */

/** Medida de latência do banco (`SELECT 1`). */
export async function pingDatabase(): Promise<{ ok: boolean; ms: number | null; error?: string }> {
	const started = Date.now();
	try {
		await prisma.$queryRaw`SELECT 1`;
		return { ok: true, ms: Date.now() - started };
	} catch (error) {
		return { ok: false, ms: null, error: shortReason(scrubString(error instanceof Error ? error.message : String(error)), "falha ao consultar") };
	}
}

export async function countPushSubscriptions(userId: string): Promise<number> {
	return prisma.pushSubscription.count({ where: { userId } });
}

/** O usuário salvou a chave do Composio (conector com catálogo `composio`)? */
export async function hasComposioKey(userId: string): Promise<boolean> {
	return (await prisma.mcpConnection.count({ where: { userId, catalogId: COMPOSIO_CATALOG_ID } })) > 0;
}

/** Últimas falhas de runs, reflexões e rotinas do usuário, da mais nova para a mais antiga. */
export async function listRecentFailures(userId: string, limit = 10): Promise<DiagnosticsFailure[]> {
	const take = Math.max(1, Math.min(30, limit));
	const [runs, reflections, routineRuns] = await Promise.all([
		prisma.agentRun.findMany({
			where: { userId, status: "failed", origin: { not: "subagent" } },
			orderBy: { createdAt: "desc" },
			take,
			select: { id: true, objective: true, error: true, finishedAt: true, createdAt: true },
		}),
		prisma.orchestratorReflection.findMany({
			where: { userId, status: "failed" },
			orderBy: { createdAt: "desc" },
			take,
			select: { id: true, detail: true, finishedAt: true, createdAt: true },
		}),
		prisma.routineRun.findMany({
			where: { status: "failed", routine: { userId } },
			orderBy: { createdAt: "desc" },
			take,
			select: { id: true, error: true, finishedAt: true, createdAt: true, routine: { select: { name: true } } },
		}),
	]);
	const failures: DiagnosticsFailure[] = [
		...runs.map((run) => ({
			kind: "run" as const,
			id: run.id,
			label: shortReason(scrubString(run.objective), "execução"),
			reason: shortReason(scrubString(run.error ?? "")),
			at: (run.finishedAt ?? run.createdAt).toISOString(),
		})),
		...reflections.map((row) => ({
			kind: "reflection" as const,
			id: row.id,
			label: "Reflexão diária",
			reason: shortReason(scrubString(row.detail ?? "")),
			at: (row.finishedAt ?? row.createdAt).toISOString(),
		})),
		...routineRuns.map((row) => ({
			kind: "routine" as const,
			id: row.id,
			label: shortReason(row.routine.name, "rotina"),
			reason: shortReason(scrubString(row.error ?? "")),
			at: (row.finishedAt ?? row.createdAt).toISOString(),
		})),
	];
	return failures.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, take);
}
