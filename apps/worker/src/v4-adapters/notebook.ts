// Porta `Notebook` do v4 no worker (F5.1) sobre o caderno do dono (`@workspace/db`, `notes.ts`). Duas camadas, como a memória:
//  - `owner` = nota com `botId` nulo (vale para todos os bots do dono);
//  - `bot`   = nota presa ao bot do run. O bot vem preso na montagem (um adaptador por run), nunca do modelo.
// Escopo: toda função do db recebe o `userId` do run e filtra por ele na consulta. O bot do run só enxerga as notas do dono e
// as próprias (`visibleToBotId`): nota de outro bot, como a de outro dono, é `null`/`false`. Toda escrita grava o histórico
// com origem `chat` e o run que a fez.
import { pinnedNotesSection, type Notebook, type NotebookNote } from "@workspace/agent";
import { createNote, deleteNote, getNote, listPinnedNotes, searchNotes, updateNote } from "@workspace/db";
import type { OwnerNoteView } from "@workspace/shared";

export type V4NotebookDeps = {
	create: typeof createNote;
	get: typeof getNote;
	search: typeof searchNotes;
	update: typeof updateNote;
	remove: typeof deleteNote;
	listPinned: typeof listPinnedNotes;
};

export const realV4NotebookDeps: V4NotebookDeps = { create: createNote, get: getNote, search: searchNotes, update: updateNote, remove: deleteNote, listPinned: listPinnedNotes };

const toNote = (note: OwnerNoteView): NotebookNote => ({ id: note.id, layer: note.botId === null ? "owner" : "bot", title: note.title, body: note.body, pinned: note.pinned, updatedAt: new Date(note.updatedAt) });

export function createV4Notebook(input: { botId?: string | null; runId?: string; deps?: V4NotebookDeps }): Notebook {
	const deps = input.deps ?? realV4NotebookDeps;
	const botId = input.botId?.trim() || null;
	const visibleToBotId = botId;
	const write = { origin: "chat" as const, ...(input.runId && { sourceRunId: input.runId }) };
	/** Falha do db vira erro com o motivo real (a tool devolve `ok:false`); o texto do db é nosso, sem segredo. */
	const unwrap = (result: Awaited<ReturnType<typeof createNote>>): OwnerNoteView => {
		if (!result.ok) throw new Error(result.existingId ? `${result.message} (note [${result.existingId}]).` : result.message);
		return result.note;
	};

	return {
		async add(userId, add) {
			if (add.layer === "bot" && !botId) throw new Error("This run has no bot, so there is no bot notebook. Use the owner layer or tell the owner plainly.");
			return toNote(unwrap(await deps.create({ userId, botId: add.layer === "bot" ? botId : null, title: add.title, body: add.body, ...(add.pinned !== undefined && { pinned: add.pinned }), ...write })));
		},
		async search(userId, query, limit) {
			return (await deps.search({ userId, botId: visibleToBotId, query, ...(limit !== undefined && { limit }) })).map(toNote);
		},
		async get(userId, id) {
			const note = await deps.get(userId, id, { visibleToBotId });
			return note ? toNote(note) : null;
		},
		async update(userId, id, patch) {
			const result = await deps.update({ userId, id, patch, visibleToBotId, ...write });
			return result ? toNote(unwrap(result)) : null;
		},
		async pin(userId, id, pinned) {
			const result = await deps.update({ userId, id, patch: { pinned }, visibleToBotId, ...write });
			return result ? toNote(unwrap(result)) : null;
		},
		async remove(userId, id) {
			return deps.remove({ userId, id, visibleToBotId, ...write });
		},
		async listPinned(userId) {
			return deps.listPinned({ userId, botId: visibleToBotId });
		},
	};
}

/**
 * Trecho do `[context]` do run com os títulos fixados (ou `null`). Sem bot, só as notas do dono. Falha ao ler nunca
 * derruba o run (o modelo ainda acha as notas por `note_search`).
 */
export async function loadNotebookContext(input: { userId: string; botId?: string | null; deps?: V4NotebookDeps }): Promise<string | null> {
	return pinnedNotesSection(createV4Notebook({ botId: input.botId ?? null, ...(input.deps && { deps: input.deps }) }), input.userId);
}
