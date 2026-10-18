import type { Prisma } from "@prisma/client";
import type { MemoryChange, MemoryChangeAction, MemoryChangeSource, MemoryChangesPage, MemoryTarget } from "@workspace/shared";
import { prisma } from "./client.js";

/** Quanto tempo o "O que mudou" olha para trás. */
export const MEMORY_CHANGES_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const MEMORY_CHANGES_PAGE_SIZE = 20;
export const MEMORY_CHANGES_MAX_PAGE_SIZE = 50;

/** Subconjunto do client que `recordMemoryChange` usa: aceita o `prisma` e o `tx` de uma transação. */
export type MemoryChangeDb = Pick<Prisma.TransactionClient, "memoryChange">;

/** Metadados do estado anterior, guardados para restaurar a entrada fielmente no desfazer. */
export type MemoryEntryMeta = {
	category: string | null;
	confidence: number | null;
	importance: number | null;
	source: string | null;
	validUntil: string | null;
};

export function memoryMetaOf(row: {
	category?: string | null;
	confidence?: number | null;
	importance?: number | null;
	source?: string | null;
	validUntil?: Date | null;
}): MemoryEntryMeta {
	return {
		category: row.category ?? null,
		confidence: row.confidence ?? null,
		importance: row.importance ?? null,
		source: row.source ?? null,
		validUntil: row.validUntil ? row.validUntil.toISOString() : null,
	};
}

export function parseMemoryMeta(value: unknown): MemoryEntryMeta | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	const str = (v: unknown) => (typeof v === "string" ? v : null);
	const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
	return { category: str(raw.category), confidence: num(raw.confidence), importance: num(raw.importance), source: str(raw.source), validUntil: str(raw.validUntil) };
}

export async function recordMemoryChange(
	db: MemoryChangeDb,
	input: {
		userId: string;
		botId?: string | null;
		entryId?: string | null;
		target: MemoryTarget;
		action: MemoryChangeAction;
		before?: string | null;
		after?: string | null;
		beforeMeta?: MemoryEntryMeta | null;
		source: MemoryChangeSource;
		undoOfId?: string | null;
	},
): Promise<{ id: string }> {
	return db.memoryChange.create({
		data: {
			userId: input.userId,
			botId: input.botId?.trim() || null,
			entryId: input.entryId ?? null,
			target: input.target,
			action: input.action,
			before: input.before ?? null,
			after: input.after ?? null,
			beforeMeta: input.beforeMeta ?? undefined,
			source: input.source,
			undoOfId: input.undoOfId ?? null,
		},
		select: { id: true },
	});
}

type ChangeRow = {
	id: string;
	botId: string | null;
	entryId: string | null;
	target: string;
	action: string;
	before: string | null;
	after: string | null;
	source: string;
	undoOfId: string | null;
	createdAt: Date;
	undoneAt: Date | null;
};

export function toMemoryChange(row: ChangeRow): MemoryChange {
	return {
		id: row.id,
		botId: row.botId,
		entryId: row.entryId,
		target: row.target as MemoryTarget,
		action: row.action as MemoryChangeAction,
		before: row.before,
		after: row.after,
		source: row.source as MemoryChangeSource,
		undoOfId: row.undoOfId,
		createdAt: row.createdAt.toISOString(),
		undoneAt: row.undoneAt ? row.undoneAt.toISOString() : null,
	};
}

/** O bot é do usuário? (antes de listar/gravar memória de um bot, para o id alheio virar 404.) */
export async function isBotOwnedBy(userId: string, botId: string): Promise<boolean> {
	const bot = await prisma.bot.findFirst({ where: { id: botId, ownerId: userId }, select: { id: true } });
	return Boolean(bot);
}

/**
 * Mudanças dos últimos 30 dias visíveis neste bot: o perfil `user` (todos os bots veem) e a memória
 * privada dele. Mais novas primeiro; paginado por cursor (id da última linha da página anterior).
 */
export async function listMemoryChanges(input: {
	userId: string;
	botId?: string;
	cursor?: string;
	limit?: number;
	now?: Date;
}): Promise<MemoryChangesPage> {
	const now = input.now ?? new Date();
	const take = Math.min(Math.max(input.limit ?? MEMORY_CHANGES_PAGE_SIZE, 1), MEMORY_CHANGES_MAX_PAGE_SIZE);
	const botId = input.botId?.trim();
	const rows = await prisma.memoryChange.findMany({
		where: {
			userId: input.userId,
			createdAt: { gte: new Date(now.getTime() - MEMORY_CHANGES_WINDOW_MS) },
			OR: botId ? [{ target: "user" }, { target: "memory", botId }] : [{ target: "user" }],
		},
		orderBy: [{ createdAt: "desc" }, { id: "desc" }],
		take: take + 1,
		...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
	});
	const page = rows.slice(0, take);
	return { changes: page.map(toMemoryChange), nextCursor: rows.length > take ? (page[page.length - 1]?.id ?? null) : null };
}
