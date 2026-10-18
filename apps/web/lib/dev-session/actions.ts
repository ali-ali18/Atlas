import { killDevJob, listDevSessions, resumeDevSession, stopDevSession } from "@/lib/atlas-api";

import { isDevSessionActive, type DevCommandView, type DevSessionView } from "./reducer";
import { getDevSessionSnapshot, ingestDevSessionEvent } from "./store";

function currentTier(sessionId: string) {
	return getDevSessionSnapshot().sessions[sessionId]?.tier ?? "small";
}

/** Encerra um comando em execução e já marca o card como interrompido. */
export async function stopDevCommand(sessionId: string, command: Pick<DevCommandView, "callId" | "jobId" | "startedAt">): Promise<void> {
	// Job perdido (container recriado/sessão parada): o servidor já não o conhece; só limpa o card.
	const result = await killDevJob(sessionId, command.jobId).catch(() => ({ running: false, lost: true }));
	if (result.running) return;
	ingestDevSessionEvent({
		type: "shell_done",
		sessionId,
		callId: command.callId,
		jobId: command.jobId,
		exitCode: null,
		durationMs: Math.max(0, Date.now() - command.startedAt),
		endedReason: "lost" in result ? "lost" : "killed",
	});
}

/** Para a sessão (o servidor também cancela o run em andamento da conversa). */
export async function stopDevSessionNow(sessionId: string): Promise<void> {
	await stopDevSession(sessionId);
	ingestDevSessionEvent({ type: "dev_session_status", sessionId, status: "STOPPED", tier: currentTier(sessionId) });
}

export async function resumeDevSessionNow(sessionId: string): Promise<void> {
	await resumeDevSession(sessionId);
	ingestDevSessionEvent({ type: "dev_session_status", sessionId, status: "RUNNING", tier: currentTier(sessionId) });
}

/** "Parar" do composer: além do run, para as sessões de código ativas da conversa. */
export async function stopConversationDevSessions(conversationId: string): Promise<void> {
	const sessions = await listDevSessions(conversationId);
	await Promise.all(
		sessions
			.filter((session) => session.status === "CREATING" || session.status === "QUEUED" || session.status === "RUNNING")
			.map((session) => stopDevSessionNow(session.id).catch(() => undefined)),
	);
}

export function canResumeDevSession(view: Pick<DevSessionView, "status">): boolean {
	return view.status === "STOPPED" || view.status === "IDLE";
}

export function canStopDevSession(view: Pick<DevSessionView, "status">): boolean {
	return isDevSessionActive(view.status);
}

/** "118k" / "950". */
export function formatTokens(count: number): string {
	return count >= 1000 ? `${Math.round(count / 1000)}k` : String(Math.max(0, Math.round(count)));
}
