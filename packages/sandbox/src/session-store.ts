import { clearTabNoticesForPort } from "./control-client.js";
import type { SandboxSessionRecord } from "./types.js";

const sessions = new Map<string, SandboxSessionRecord>();

export function putSession(record: SandboxSessionRecord): void {
	if (!record.userId?.trim() || record.userId === "default") throw new Error("Sandbox owner required");
	const existing = sessions.get(record.sessionId);
	if (existing && existing.userId !== record.userId) throw new Error("Sandbox owner mismatch");
	// VM nova numa porta (re)usada não herda o aviso de aba da anterior.
	if (!existing && record.controlPort) clearTabNoticesForPort(record.controlPort);
	sessions.set(record.sessionId, record);
}

export function getSession(sessionId: string, userId: string): SandboxSessionRecord | undefined {
	const record = sessions.get(sessionId);
	return record?.userId === userId ? record : undefined;
}

export function deleteSession(sessionId: string, userId: string): boolean {
	const record = getSession(sessionId, userId);
	if (!record) return false;
	if (record.controlPort) clearTabNoticesForPort(record.controlPort);
	return sessions.delete(sessionId);
}

export function listSessions(userId: string): SandboxSessionRecord[] {
	return [...sessions.values()].filter((record) => record.userId === userId);
}

/** Inventário interno do reaper; nunca exposto por rotas ou controles. */
export function listAllSessionsForCleanup(): SandboxSessionRecord[] {
	return [...sessions.values()];
}

export function findByConversationId(
	conversationId: string,
	userId: string,
): SandboxSessionRecord | undefined {
	for (const record of sessions.values()) {
		if (record.conversationId === conversationId && record.userId === userId) return record;
	}
	return undefined;
}

/** Marca a sessão como usada agora (renova o TTL). */
export function touchSession(sessionId: string, userId: string): void {
	const record = getSession(sessionId, userId);
	if (record) {
		record.lastUsedAt = new Date();
	}
}
