/**
 * Desfazer de uma mudança no caderno (F5.1/F5.3). Mesmo contrato do desfazer da memória (`memory-undo.ts`): numa
 * transação, marca a mudança como desfeita, aplica o inverso só se a nota ainda está como a mudança a deixou (senão
 * RECUSA com `stale`, nunca sobrescreve) e grava o desfazer no histórico (origem `user`, `undoOfId`).
 *  - add → apaga a nota; replace → devolve título, texto e fixada de antes; remove → recria (mesmo id, se livre).
 */
import { OWNER_NOTES_MAX_PER_OWNER, findDuplicateNote } from "@workspace/shared";
import { prisma } from "./client.js";
import { parseNoteMeta, recordMemoryChange, toMemoryChange } from "./memory-changes.js";
import type { MemoryUndoCode, MemoryUndoResult } from "./memory-undo.js";

class NoteUndoRefusal extends Error {
	constructor(readonly code: MemoryUndoCode) {
		super(code);
	}
}

type ChangeRow = {
	id: string;
	userId: string;
	botId: string | null;
	entryId: string | null;
	action: string;
	before: string | null;
	after: string | null;
	beforeMeta: unknown;
	afterMeta: unknown;
	undoOfId: string | null;
	undoneAt: Date | null;
	reportId: string | null;
};

/** Recusas com o vocabulário do caderno; as demais (não achou, já desfeita) usam o texto comum. */
const NOTE_MESSAGES: Partial<Record<MemoryUndoCode, string>> = {
	stale: "Não deu para desfazer: a nota foi alterada depois. Edite ou apague direto na lista.",
	duplicate: "Não deu para desfazer: já existe uma nota com esse mesmo texto.",
	limit: "Não deu para desfazer: o caderno está cheio. Apague uma nota e tente de novo.",
};

export async function undoNoteChange(change: ChangeRow, now: Date, messages: Readonly<Record<MemoryUndoCode, string>>): Promise<MemoryUndoResult> {
	const { userId } = change;
	const refuse = (code: MemoryUndoCode): MemoryUndoResult => ({ ok: false, code, message: NOTE_MESSAGES[code] ?? messages[code] });
	const beforeMeta = parseNoteMeta(change.beforeMeta);
	const afterMeta = parseNoteMeta(change.afterMeta);
	try {
		const created = await prisma.$transaction(async (tx) => {
			const claimed = await tx.memoryChange.updateMany({ where: { id: change.id, userId, undoneAt: null }, data: { undoneAt: now } });
			if (claimed.count === 0) throw new NoteUndoRefusal("already_undone");
			const current = change.entryId ? await tx.note.findFirst({ where: { id: change.entryId, userId } }) : null;
			const meta = (note: { title: string; pinned: boolean }) => ({ title: note.title, pinned: note.pinned });
			const stateOf = (note: { title: string; body: string; pinned: boolean }) => `${note.title}\n${note.pinned}\n${note.body}`;

			if (change.action === "add") {
				if (!current || !afterMeta || stateOf(current) !== `${afterMeta.title}\n${afterMeta.pinned}\n${change.after}`) throw new NoteUndoRefusal("stale");
				await tx.note.deleteMany({ where: { id: current.id, userId } });
				return recordMemoryChange(tx, { userId, botId: change.botId, entryId: current.id, target: "note", action: "remove", before: current.body, beforeMeta: meta(current), source: "user", undoOfId: change.id });
			}

			if (change.action === "replace") {
				if (!current || !beforeMeta || !afterMeta || change.before === null || stateOf(current) !== `${afterMeta.title}\n${afterMeta.pinned}\n${change.after}`) throw new NoteUndoRefusal("stale");
				const others = await tx.note.findMany({ where: { userId, botId: current.botId }, select: { id: true, body: true, botId: true } });
				if (findDuplicateNote(others, { body: change.before, botId: current.botId }, current.id)) throw new NoteUndoRefusal("duplicate");
				const restored = await tx.note.update({ where: { id: current.id }, data: { title: beforeMeta.title, body: change.before, pinned: beforeMeta.pinned } });
				return recordMemoryChange(tx, { userId, botId: change.botId, entryId: current.id, target: "note", action: "replace", before: current.body, after: restored.body, beforeMeta: meta(current), afterMeta: meta(restored), source: "user", undoOfId: change.id });
			}

			// remove → recria
			if (change.before === null || !beforeMeta) throw new NoteUndoRefusal("stale");
			if ((await tx.note.count({ where: { userId } })) >= OWNER_NOTES_MAX_PER_OWNER) throw new NoteUndoRefusal("limit");
			const others = await tx.note.findMany({ where: { userId, botId: change.botId }, select: { id: true, body: true, botId: true } });
			if (findDuplicateNote(others, { body: change.before, botId: change.botId })) throw new NoteUndoRefusal("duplicate");
			// O id só se reaproveita se estiver livre para QUALQUER dono (a chave é global); senão nasce um novo.
			const idTaken = change.entryId ? await tx.note.findFirst({ where: { id: change.entryId }, select: { id: true } }) : null;
			const restored = await tx.note.create({ data: { ...(change.entryId && !idTaken ? { id: change.entryId } : {}), userId, botId: change.botId, title: beforeMeta.title, body: change.before, pinned: beforeMeta.pinned, source: "owner" } });
			return recordMemoryChange(tx, { userId, botId: change.botId, entryId: restored.id, target: "note", action: "add", after: restored.body, afterMeta: meta(restored), source: "user", undoOfId: change.id });
		});
		const row = await prisma.memoryChange.findFirst({ where: { id: created.id, userId } });
		return row ? { ok: true, change: toMemoryChange(row) } : refuse("not_found");
	} catch (error) {
		if (error instanceof NoteUndoRefusal) return refuse(error.code);
		throw error;
	}
}
