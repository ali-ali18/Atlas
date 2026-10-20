import type { MemoryTarget } from "./memory.js";

/**
 * Limpeza das memórias existentes COM aprovação: o worker só SUGERE (apagar ou fundir); nada muda até o
 * usuário aplicar na aba Memória. As sugestões ficam no bot (`Bot.memoryCleanupJson`) até serem tratadas.
 */

export const MEMORY_CLEANUP_STALE_MS = 5 * 60_000;
export const MEMORY_CLEANUP_STALE_MESSAGE = "A revisão não terminou; tente de novo";
export const MEMORY_CLEANUP_MAX_SUGGESTIONS = 40;
export const MEMORY_CLEANUP_REASON_MAX_CHARS = 160;
export const MEMORY_CLEANUP_CONTENT_MAX_CHARS = 600;

export type MemoryCleanupKind = "delete" | "merge";
export type MemoryCleanupStatus = "generating" | "failed";

export type MemoryCleanupSuggestion = {
	id: string;
	kind: MemoryCleanupKind;
	target: MemoryTarget;
	/** Entradas afetadas (1 para apagar; 2+ para fundir). */
	entryIds: string[];
	/** Texto atual de cada entrada, para a UI mostrar o que muda sem outra consulta. */
	before: string[];
	/** Texto fundido (só em `merge`). */
	content?: string;
	reason: string;
	createdAt: string;
};

export type MemoryCleanupView = {
	suggestions: MemoryCleanupSuggestion[];
	status: MemoryCleanupStatus | null;
	error: string | null;
	requestedAt: string | null;
};

/** Payload do job `memory.cleanup` (revisar as memórias de um bot e do usuário). */
export type MemoryCleanupJobPayload = { userId: string; botId: string };
export type MemoryCleanupJobResult = { status: "done" | "failed" | "skipped"; suggestions?: number; reason?: string };

/** Estado efetivo: "generating" velho demais vira "failed" com mensagem fixa. */
export function resolveMemoryCleanupStatus(
	raw: { status?: string | null; error?: string | null; requestedAt?: Date | null },
	now: Date = new Date(),
): { status: MemoryCleanupStatus | null; error: string | null } {
	if (raw.status === "failed") return { status: "failed", error: raw.error?.trim() || "Não foi possível revisar as memórias" };
	if (raw.status === "generating") {
		const started = raw.requestedAt?.getTime();
		if (started === undefined || now.getTime() - started > MEMORY_CLEANUP_STALE_MS) return { status: "failed", error: MEMORY_CLEANUP_STALE_MESSAGE };
		return { status: "generating", error: null };
	}
	return { status: null, error: null };
}

/** Lê o JSON gravado, descartando o que não tem o formato esperado (o banco guarda JSON livre). */
export function parseMemoryCleanupSuggestions(raw: unknown): MemoryCleanupSuggestion[] {
	if (!Array.isArray(raw)) return [];
	const out: MemoryCleanupSuggestion[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object" || Array.isArray(item)) continue;
		const row = item as Record<string, unknown>;
		const kind = row.kind === "delete" || row.kind === "merge" ? row.kind : null;
		const target = row.target === "user" || row.target === "memory" ? row.target : null;
		const ids = Array.isArray(row.entryIds) ? row.entryIds.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
		const before = Array.isArray(row.before) ? row.before.filter((text): text is string => typeof text === "string") : [];
		if (typeof row.id !== "string" || !kind || !target || ids.length === 0) continue;
		if (kind === "merge" && (ids.length < 2 || typeof row.content !== "string" || !row.content.trim())) continue;
		out.push({
			id: row.id,
			kind,
			target,
			entryIds: ids,
			before,
			...(kind === "merge" ? { content: (row.content as string).slice(0, MEMORY_CLEANUP_CONTENT_MAX_CHARS) } : {}),
			reason: typeof row.reason === "string" ? row.reason.slice(0, MEMORY_CLEANUP_REASON_MAX_CHARS) : "",
			createdAt: typeof row.createdAt === "string" ? row.createdAt : new Date(0).toISOString(),
		});
	}
	return out;
}
