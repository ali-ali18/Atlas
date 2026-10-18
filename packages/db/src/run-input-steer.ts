import type { RunInputRecord } from "@workspace/shared";
import { prisma } from "./client.js";

/**
 * "Enviar agora": a mensagem que estava na fila (`queue`, roda depois do run) passa a
 * entrar no run em andamento (`join`, no próximo passo). Só vale para input pendente
 * de um run do usuário; devolve `null` se não achou, já foi consumido ou não era fila.
 */
export async function promoteQueuedInputToSteer(runId: string, inputId: string, userId: string): Promise<RunInputRecord | null> {
	const run = await prisma.agentRun.findFirst({ where: { id: runId, userId }, select: { id: true, status: true } });
	if (!run) return null;
	const updated = await prisma.runInput.updateMany({
		where: { id: inputId, runId, status: "pending", mode: "queue" },
		data: { mode: "join" },
	});
	if (updated.count === 0) return null;
	const row = await prisma.runInput.findUnique({ where: { id: inputId } });
	if (!row) return null;
	return {
		id: row.id,
		runId: row.runId,
		seq: row.seq,
		author: row.author,
		content: row.content,
		mode: "join",
		status: row.status as RunInputRecord["status"],
		clientKey: row.clientKey ?? null,
		createdAt: row.createdAt.toISOString(),
		consumedAt: row.consumedAt ? row.consumedAt.toISOString() : null,
	};
}

/**
 * "Deixar para quando terminar": a mensagem que ia entrar no próximo passo (`join`) vira
 * fila (`queue`, roda depois do run). Espelho de `promoteQueuedInputToSteer`.
 */
export async function demoteSteerInputToQueue(runId: string, inputId: string, userId: string): Promise<RunInputRecord | null> {
	const run = await prisma.agentRun.findFirst({ where: { id: runId, userId }, select: { id: true } });
	if (!run) return null;
	const updated = await prisma.runInput.updateMany({
		where: { id: inputId, runId, status: "pending", mode: { in: ["join", "steer"] } },
		data: { mode: "queue" },
	});
	if (updated.count === 0) return null;
	const row = await prisma.runInput.findUnique({ where: { id: inputId } });
	if (!row) return null;
	return {
		id: row.id,
		runId: row.runId,
		seq: row.seq,
		author: row.author,
		content: row.content,
		mode: "queue",
		status: row.status as RunInputRecord["status"],
		clientKey: row.clientKey ?? null,
		createdAt: row.createdAt.toISOString(),
		consumedAt: row.consumedAt ? row.consumedAt.toISOString() : null,
	};
}
