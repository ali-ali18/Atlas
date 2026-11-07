/**
 * Caderno do dono (Motor v4, F5.1) no banco. TODA função recebe o `userId` e filtra por ele na própria consulta
 * (`where: { id, userId }`); nota de outro dono é indistinguível de inexistente (`null`), e a rota responde 404.
 *
 * Visibilidade para um bot: nota do dono (`botId` nulo) ou deste bot. A API do dono (UI) vê todas as dele.
 * Toda escrita grava o histórico (`MemoryChange`, alvo `note`) na MESMA transação, então chat, API e sono ficam
 * todos no "o que mudou" e todos se desfazem (`notes-undo.ts`).
 */
import { Prisma } from "@prisma/client";
import {
	OWNER_NOTES_MAX_PER_OWNER,
	OWNER_NOTES_PINNED_CONTEXT_MAX,
	OWNER_NOTES_SEARCH_DEFAULT_LIMIT,
	findDuplicateNote,
	rankNotes,
	type MemoryChange,
	type MemoryChangeSource,
	type MemoryChangesPage,
	type OwnerNoteSource,
	type OwnerNoteView,
} from "@workspace/shared";
import { prisma } from "./client.js";
import { MEMORY_CHANGES_MAX_PAGE_SIZE, MEMORY_CHANGES_PAGE_SIZE, MEMORY_CHANGES_WINDOW_MS, recordMemoryChange, toMemoryChange } from "./memory-changes.js";

type NoteRow = { id: string; botId: string | null; title: string; body: string; pinned: boolean; source: string; createdAt: Date; updatedAt: Date };

export function toOwnerNote(row: NoteRow): OwnerNoteView {
	return { id: row.id, botId: row.botId, title: row.title, body: row.body, pinned: row.pinned, source: row.source as OwnerNoteSource, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

export type NoteFailure = { ok: false; code: "limit" | "duplicate" | "conflict"; message: string; existingId?: string };
export type NoteResult = { ok: true; note: OwnerNoteView } | NoteFailure;

const LIMIT_MESSAGE = `O caderno chegou ao limite de ${OWNER_NOTES_MAX_PER_OWNER} notas. Apague alguma para guardar outra.`;
const metaOf = (note: { title: string; pinned: boolean }) => ({ title: note.title, pinned: note.pinned });

/** Onde a nota vive para quem consulta: o bot vê as do dono e as suas; sem bot (UI), vê tudo do dono. */
function visibleTo(botId: string | null | undefined): Prisma.NoteWhereInput {
	return botId === undefined ? {} : botId === null ? { botId: null } : { OR: [{ botId: null }, { botId }] };
}

export async function getNote(userId: string, id: string, input: { visibleToBotId?: string | null } = {}): Promise<OwnerNoteView | null> {
	const row = await prisma.note.findFirst({ where: { id, userId, ...visibleTo(input.visibleToBotId) } });
	return row ? toOwnerNote(row) : null;
}

/** Notas do dono, as fixadas primeiro e depois as mais recentes. `botId` filtra a visão de um bot (do dono + do bot). */
export async function listNotes(input: { userId: string; botId?: string | null; pinnedOnly?: boolean; limit?: number }): Promise<OwnerNoteView[]> {
	const rows = await prisma.note.findMany({
		where: { userId: input.userId, ...visibleTo(input.botId), ...(input.pinnedOnly && { pinned: true }) },
		orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }, { id: "asc" }],
		take: Math.min(Math.max(1, Math.floor(input.limit ?? OWNER_NOTES_MAX_PER_OWNER)), OWNER_NOTES_MAX_PER_OWNER),
	});
	return rows.map(toOwnerNote);
}

/** Títulos fixados que entram no `[context]` do bot (os mais recentes primeiro; o teto de exibição é de quem renderiza). */
export async function listPinnedNotes(input: { userId: string; botId: string | null }): Promise<Array<Pick<OwnerNoteView, "id" | "title">>> {
	const rows = await prisma.note.findMany({
		where: { userId: input.userId, pinned: true, ...visibleTo(input.botId) },
		orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
		take: OWNER_NOTES_PINNED_CONTEXT_MAX * 4,
		select: { id: true, title: true },
	});
	return rows;
}

/** Busca no caderno visível ao bot. Varre todas (o teto por dono garante que nenhuma fica de fora) e ranqueia em código puro. */
export async function searchNotes(input: { userId: string; botId?: string | null; query: string; limit?: number }): Promise<OwnerNoteView[]> {
	const rows = await prisma.note.findMany({ where: { userId: input.userId, ...visibleTo(input.botId) }, orderBy: { updatedAt: "desc" }, take: OWNER_NOTES_MAX_PER_OWNER });
	return rankNotes(rows.map(toOwnerNote), input.query, input.limit ?? OWNER_NOTES_SEARCH_DEFAULT_LIMIT);
}

async function duplicateOf(client: Prisma.TransactionClient, userId: string, candidate: { body: string; botId: string | null }, ignoreId?: string): Promise<string | null> {
	const rows = await client.note.findMany({ where: { userId, botId: candidate.botId }, select: { id: true, body: true, botId: true } });
	return findDuplicateNote(rows, candidate, ignoreId)?.id ?? null;
}

export type NoteWriteContext = {
	/** Quem escreve: `user` = UI/API, `chat` = tool do agente, `sleep` = sono. */
	origin: MemoryChangeSource;
	reportId?: string;
	sourceRunId?: string;
};

const SOURCE_OF: Readonly<Record<string, OwnerNoteSource>> = { user: "owner", chat: "agent", sleep: "sleep" };

export async function createNote(input: { userId: string; botId: string | null; title: string; body: string; pinned?: boolean } & NoteWriteContext): Promise<NoteResult> {
	const pinned = input.pinned === true;
	return prisma.$transaction(async (tx): Promise<NoteResult> => {
		if ((await tx.note.count({ where: { userId: input.userId } })) >= OWNER_NOTES_MAX_PER_OWNER) return { ok: false, code: "limit", message: LIMIT_MESSAGE };
		const existingId = await duplicateOf(tx, input.userId, { body: input.body, botId: input.botId });
		if (existingId) return { ok: false, code: "duplicate", message: "Já existe uma nota com esse mesmo texto.", existingId };
		const row = await tx.note.create({ data: { userId: input.userId, botId: input.botId, title: input.title, body: input.body, pinned, source: SOURCE_OF[input.origin] ?? "owner", sourceRunId: input.sourceRunId ?? null } });
		await recordMemoryChange(tx, { userId: input.userId, botId: input.botId, entryId: row.id, target: "note", action: "add", after: row.body, afterMeta: metaOf(row), source: input.origin, reportId: input.reportId ?? null });
		return { ok: true, note: toOwnerNote(row) };
	});
}

/** Edita título, texto e/ou fixada. `null` = não existe (ou não é visível a quem pede). Sem mudança real, devolve a nota sem gravar histórico. */
export async function updateNote(input: { userId: string; id: string; patch: { title?: string; body?: string; pinned?: boolean }; visibleToBotId?: string | null } & NoteWriteContext): Promise<NoteResult | null> {
	return prisma.$transaction(async (tx): Promise<NoteResult | null> => {
		const row = await tx.note.findFirst({ where: { id: input.id, userId: input.userId, ...visibleTo(input.visibleToBotId) } });
		if (!row) return null;
		const next = { title: input.patch.title ?? row.title, body: input.patch.body ?? row.body, pinned: input.patch.pinned ?? row.pinned };
		if (next.title === row.title && next.body === row.body && next.pinned === row.pinned) return { ok: true, note: toOwnerNote(row) };
		if (next.body !== row.body) {
			const existingId = await duplicateOf(tx, input.userId, { body: next.body, botId: row.botId }, row.id);
			if (existingId) return { ok: false, code: "duplicate", message: "Já existe outra nota com esse mesmo texto.", existingId };
		}
		// Condiciona ao estado lido: se outra escrita passou no meio, não sobrescreve às cegas.
		const changed = await tx.note.updateMany({ where: { id: row.id, userId: input.userId, updatedAt: row.updatedAt }, data: next });
		if (changed.count === 0) return { ok: false, code: "conflict", message: "A nota mudou enquanto você editava. Abra de novo e refaça a edição." };
		const updated = await tx.note.findFirstOrThrow({ where: { id: row.id, userId: input.userId } });
		await recordMemoryChange(tx, { userId: input.userId, botId: row.botId, entryId: row.id, target: "note", action: "replace", before: row.body, after: updated.body, beforeMeta: metaOf(row), afterMeta: metaOf(updated), source: input.origin, reportId: input.reportId ?? null });
		return { ok: true, note: toOwnerNote(updated) };
	});
}

/** Apaga a nota (e registra o antes, para o desfazer recriar). `false` = não existe ou não é visível. */
export async function deleteNote(input: { userId: string; id: string; visibleToBotId?: string | null } & NoteWriteContext): Promise<boolean> {
	return prisma.$transaction(async (tx) => {
		const row = await tx.note.findFirst({ where: { id: input.id, userId: input.userId, ...visibleTo(input.visibleToBotId) } });
		if (!row) return false;
		const removed = await tx.note.deleteMany({ where: { id: row.id, userId: input.userId } });
		if (removed.count === 0) return false;
		await recordMemoryChange(tx, { userId: input.userId, botId: row.botId, entryId: row.id, target: "note", action: "remove", before: row.body, beforeMeta: metaOf(row), source: input.origin, reportId: input.reportId ?? null });
		return true;
	});
}

const CHANGE_ORDER = [{ createdAt: "desc" }, { id: "desc" }] as const;

async function pageOfChanges(where: Prisma.MemoryChangeWhereInput, input: { cursor?: string; limit?: number }): Promise<MemoryChangesPage> {
	const take = Math.min(Math.max(input.limit ?? MEMORY_CHANGES_PAGE_SIZE, 1), MEMORY_CHANGES_MAX_PAGE_SIZE);
	const rows = await prisma.memoryChange.findMany({ where, orderBy: [...CHANGE_ORDER], take: take + 1, ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}) });
	const page = rows.slice(0, take);
	return { changes: page.map((row) => toMemoryChange(row) as MemoryChange), nextCursor: rows.length > take ? (page[page.length - 1]?.id ?? null) : null };
}

/** "O que mudou" no caderno do dono, dos últimos 30 dias. */
export async function listNoteChanges(input: { userId: string; botId?: string; cursor?: string; limit?: number; now?: Date }): Promise<MemoryChangesPage> {
	const now = input.now ?? new Date();
	return pageOfChanges({ userId: input.userId, target: "note", createdAt: { gte: new Date(now.getTime() - MEMORY_CHANGES_WINDOW_MS) }, ...(input.botId && { OR: [{ botId: null }, { botId: input.botId }] }) }, input);
}

/** Tudo o que o sono mudou (memória e caderno), com o desfazer de cada linha. `reportId` restringe a uma noite. */
export async function listSleepChanges(input: { userId: string; botId?: string; reportId?: string; cursor?: string; limit?: number; now?: Date }): Promise<MemoryChangesPage> {
	const now = input.now ?? new Date();
	return pageOfChanges({ userId: input.userId, source: "sleep", createdAt: { gte: new Date(now.getTime() - MEMORY_CHANGES_WINDOW_MS) }, ...(input.botId && { botId: input.botId }), ...(input.reportId && { reportId: input.reportId }) }, input);
}
