/** Persistência leve do run ativo por conversa (sobrevive a F5 na mesma aba/sessão). */

const PREFIX = "atlas:active-run:";
const SSE_PREFIX = "atlas:sse-cursor:";
const DRAFT_PREFIX = "atlas:draft:";

export function activeRunStorageKey(conversationId: string): string {
	return `${PREFIX}${conversationId}`;
}

export function getStoredActiveRunId(conversationId: string): string | null {
	if (typeof window === "undefined") return null;
	try {
		const value = sessionStorage.getItem(activeRunStorageKey(conversationId));
		return value && value.trim().length > 0 ? value.trim() : null;
	} catch {
		return null;
	}
}

export function setStoredActiveRunId(
	conversationId: string,
	runId: string,
): void {
	if (typeof window === "undefined") return;
	try {
		sessionStorage.setItem(activeRunStorageKey(conversationId), runId);
	} catch {
		// ignore quota / private mode
	}
}

export function clearStoredActiveRunId(conversationId: string): void {
	if (typeof window === "undefined") return;
	try {
		sessionStorage.removeItem(activeRunStorageKey(conversationId));
	} catch {
		// ignore
	}
}

export function getStoredSseCursor(runId: string): number {
	if (typeof window === "undefined") return 0;
	try {
		const raw = localStorage.getItem(`${SSE_PREFIX}${runId}`);
		const parsed = raw ? Number.parseInt(raw, 10) : 0;
		return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
	} catch {
		return 0;
	}
}

export function setStoredSseCursor(runId: string, seq: number): void {
	if (typeof window === "undefined") return;
	try {
		localStorage.setItem(`${SSE_PREFIX}${runId}`, String(seq));
	} catch {
		// ignore
	}
}

export function clearStoredSseCursor(runId: string): void {
	if (typeof window === "undefined") return;
	try {
		localStorage.removeItem(`${SSE_PREFIX}${runId}`);
	} catch {
		// ignore
	}
}

export function getStoredDraft(conversationKey: string): string {
	if (typeof window === "undefined") return "";
	try {
		return localStorage.getItem(`${DRAFT_PREFIX}${conversationKey}`) ?? "";
	} catch {
		return "";
	}
}

export function setStoredDraft(conversationKey: string, value: string): void {
	if (typeof window === "undefined") return;
	try {
		if (value.trim().length === 0) {
			localStorage.removeItem(`${DRAFT_PREFIX}${conversationKey}`);
			return;
		}
		localStorage.setItem(`${DRAFT_PREFIX}${conversationKey}`, value);
	} catch {
		// ignore
	}
}
