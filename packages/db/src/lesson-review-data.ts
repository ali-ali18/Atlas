/**
 * Leituras do job `lesson.review` (todas filtradas pelo dono): quais runs de chat da conversa entram na janela,
 * quais já foram revisados e o último resultado da revisão (para o inspetor do run seguinte).
 */
import { prisma } from "./client.js";

export type LessonReviewRun = { id: string; status: string; createdAt: Date; finishedAt: Date | null };

export const LESSON_REVIEW_EVENT = "lesson_review";
const MAX_RUNS = 3;

/** Runs de chat concluídos da conversa do dono desde `since` (mais antigo primeiro), no máximo 3. */
export async function listRunsForLessonReview(userId: string, conversationId: string, since: Date): Promise<LessonReviewRun[]> {
	if (!userId.trim() || userId === "default" || !conversationId.trim()) return [];
	const rows = await prisma.agentRun.findMany({
		where: { userId, conversationId, origin: "chat", parentRunId: null, status: { in: ["completed", "budget_exhausted"] }, createdAt: { gte: since } },
		select: { id: true, status: true, createdAt: true, finishedAt: true },
		orderBy: { createdAt: "desc" },
		take: MAX_RUNS,
	});
	return rows.reverse();
}

/** Dos runs dados, quais já têm o evento de revisão (a janela de debounce não revisa duas vezes o mesmo run). */
export async function runIdsAlreadyReviewed(userId: string, runIds: readonly string[]): Promise<Set<string>> {
	if (runIds.length === 0) return new Set();
	const rows = await prisma.runEvent.findMany({ where: { type: LESSON_REVIEW_EVENT, runId: { in: [...runIds] }, run: { userId } }, select: { runId: true } });
	return new Set(rows.map((row) => row.runId));
}

/** Último resultado de revisão de lições da conversa (de um run anterior a `excludeRunId`). Só o dono. */
export async function getLatestLessonReviewEvent(userId: string, conversationId: string, excludeRunId: string): Promise<{ runId: string; payload: unknown; createdAt: string } | null> {
	if (!userId.trim() || userId === "default" || !conversationId.trim()) return null;
	const row = await prisma.runEvent.findFirst({
		where: { type: LESSON_REVIEW_EVENT, run: { userId, conversationId }, runId: { not: excludeRunId } },
		orderBy: { createdAt: "desc" },
		select: { runId: true, payload: true, createdAt: true },
	});
	return row ? { runId: row.runId, payload: row.payload, createdAt: row.createdAt.toISOString() } : null;
}
