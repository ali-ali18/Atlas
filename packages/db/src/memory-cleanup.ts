import type { Prisma } from "@prisma/client";
import { MEMORY_CLEANUP_MAX_SUGGESTIONS, parseMemoryCleanupSuggestions, resolveMemoryCleanupStatus, type MemoryCleanupSuggestion, type MemoryCleanupView } from "@workspace/shared";
import { prisma } from "./client.js";

/**
 * Sugestões de limpeza da memória, guardadas no bot que pediu a revisão (a camada `user` entra junto, mas a
 * aba que a mostra é a deste bot). Só o dono do bot lê ou muda; nada aqui altera as memórias em si.
 */

type CleanupRow = {
	memoryCleanupJson: Prisma.JsonValue | null;
	memoryCleanupStatus: string | null;
	memoryCleanupError: string | null;
	memoryCleanupRequestedAt: Date | null;
};

const SELECT = { memoryCleanupJson: true, memoryCleanupStatus: true, memoryCleanupError: true, memoryCleanupRequestedAt: true } as const;

export function cleanupViewFromRow(row: CleanupRow, now: Date = new Date()): MemoryCleanupView {
	const state = resolveMemoryCleanupStatus({ status: row.memoryCleanupStatus, error: row.memoryCleanupError, requestedAt: row.memoryCleanupRequestedAt }, now);
	return {
		suggestions: parseMemoryCleanupSuggestions(row.memoryCleanupJson),
		status: state.status,
		error: state.error,
		requestedAt: row.memoryCleanupRequestedAt ? row.memoryCleanupRequestedAt.toISOString() : null,
	};
}

/** Sugestões e estado da revisão; null = bot inexistente ou de outro dono. */
export async function getMemoryCleanup(userId: string, botId: string): Promise<MemoryCleanupView | null> {
	const row = await prisma.bot.findFirst({ where: { id: botId, ownerId: userId }, select: SELECT });
	return row ? cleanupViewFromRow(row) : null;
}

/** Revisão pedida: a UI mostra "Revisando…" até o worker gravar as sugestões ou o motivo da falha. */
export async function markMemoryCleanupGenerating(userId: string, botId: string): Promise<boolean> {
	const result = await prisma.bot.updateMany({
		where: { id: botId, ownerId: userId },
		data: { memoryCleanupStatus: "generating", memoryCleanupError: null, memoryCleanupRequestedAt: new Date() },
	});
	return result.count === 1;
}

/** Falha visível ao usuário. `error` é texto curto em português, nunca detalhe bruto do provedor. */
export async function markMemoryCleanupFailed(userId: string, botId: string, error: string): Promise<boolean> {
	const result = await prisma.bot.updateMany({
		where: { id: botId, ownerId: userId },
		data: { memoryCleanupStatus: "failed", memoryCleanupError: error.slice(0, 200) },
	});
	return result.count === 1;
}

/** Sem pendência (ex.: o job não conseguiu enfileirar). */
export async function clearMemoryCleanupStatus(userId: string, botId: string): Promise<boolean> {
	const result = await prisma.bot.updateMany({
		where: { id: botId, ownerId: userId },
		data: { memoryCleanupStatus: null, memoryCleanupError: null, memoryCleanupRequestedAt: null },
	});
	return result.count === 1;
}

/** Substitui a lista de sugestões (nova revisão ou uma sugestão tratada) e encerra o estado "gerando". */
export async function setMemoryCleanupSuggestions(userId: string, botId: string, list: MemoryCleanupSuggestion[]): Promise<MemoryCleanupView | null> {
	const result = await prisma.bot.updateMany({
		where: { id: botId, ownerId: userId },
		data: {
			memoryCleanupJson: list.slice(0, MEMORY_CLEANUP_MAX_SUGGESTIONS) as unknown as Prisma.InputJsonValue,
			memoryCleanupStatus: null,
			memoryCleanupError: null,
			memoryCleanupRequestedAt: null,
		},
	});
	return result.count === 1 ? getMemoryCleanup(userId, botId) : null;
}
