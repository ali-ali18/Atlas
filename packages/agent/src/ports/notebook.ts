// Porta `Notebook`: o caderno do dono (F5.1), notas duráveis além do caderno de trabalho do run (`note_read`, notas `work:`).
// Duas camadas, como a memória: `owner` = vale para todos os bots do dono; `bot` = só deste bot (preso na montagem do
// adaptador, nunca de argumento do modelo). Toda chamada leva o `userId` do run e o adaptador filtra por dono; nota de
// outro dono ou de outro bot é `null`/`false`, igual a inexistente. O adaptador guarda o histórico (desfazer).
import type { MemoryLayer } from "./memory.js";

export type NotebookNote = { id: string; layer: MemoryLayer; title: string; body: string; pinned: boolean; updatedAt: Date };

export type NotebookAddInput = { layer: MemoryLayer; title: string; body: string; pinned?: boolean };
export type NotebookPatch = { title?: string; body?: string };

export interface Notebook {
	/** Falha (limite do caderno, texto repetido) LANÇA com a mensagem real; o executor devolve `ok:false`. */
	add(userId: string, input: NotebookAddInput): Promise<NotebookNote>;
	/** Sem `query`, as mais recentes. Já vem ordenado por relevância. */
	search(userId: string, query: string, limit?: number): Promise<NotebookNote[]>;
	/** `null` = não existe para este dono (inclui nota de outro dono ou de outro bot). */
	get(userId: string, id: string): Promise<NotebookNote | null>;
	update(userId: string, id: string, patch: NotebookPatch): Promise<NotebookNote | null>;
	pin(userId: string, id: string, pinned: boolean): Promise<NotebookNote | null>;
	remove(userId: string, id: string): Promise<boolean>;
	/** Títulos fixados visíveis ao bot (do dono e deste bot), mais recentes primeiro. Só id e título: o corpo se lê sob demanda. */
	listPinned(userId: string): Promise<Array<Pick<NotebookNote, "id" | "title">>>;
}
