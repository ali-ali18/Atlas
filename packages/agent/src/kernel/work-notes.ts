// Caderno de trabalho do run (F1.8b). Nada que está em uso é cortado para caber:
//  - saída grande de tool vai INTEIRA para o caderno e o modelo recebe uma página + o ponteiro
//    `note_read(id, offset)` para ler o resto (limite técnico de janela, nunca economia);
//  - a compactação grava o material antes de resumir (compaction.ts) e a referência fica no resumo.
// Invariante (testado): nenhuma saída chega ao modelo truncada sem ponteiro.
import { z } from "zod";
import { defineTool, type Tool } from "../tools/define-tool.js";
import { readNoteRange, type Store } from "../ports/store.js";

export const WORK_NOTE_PREFIX = "work:";
export const NOTE_READ_TOOL = "note_read";
export const DEFAULT_PAGE_CHARS = 24_000;

export type Page = { text: string; start: number; end: number; total: number };

/** Página de `text` a partir de `offset` (em caracteres), sem partir um par substituto UTF-16. */
export function pageOf(text: string, offset: number, pageChars: number): Page {
	const start = Math.min(Math.max(0, Math.floor(offset)), text.length);
	let end = Math.min(text.length, start + pageChars);
	if (end < text.length && end > start) {
		const code = text.charCodeAt(end - 1);
		if (code >= 0xd800 && code <= 0xdbff) end--;
	}
	return { text: text.slice(start, end), start, end, total: text.length };
}

/** Página a partir de uma faixa já lida (`part.text` começa em `start`), com a mesma regra do par substituto de `pageOf`. */
export function pageOfRange(part: { text: string; total: number }, start: number): Page {
	const from = Math.min(start, part.total);
	let text = part.text;
	if (from + text.length < part.total && text.length > 1) {
		const code = text.charCodeAt(text.length - 1);
		if (code >= 0xd800 && code <= 0xdbff) text = text.slice(0, -1);
	}
	return { text, start: from, end: from + text.length, total: part.total };
}

export function pointerText(id: string, page: Page): string {
	if (page.end >= page.total) return `[End of the content: characters ${page.start}-${page.end} of ${page.total}.]`;
	return `[Characters ${page.start}-${page.end} of ${page.total}. Nothing was dropped: read the rest with ${NOTE_READ_TOOL}(id="${id}", offset=${page.end}).]`;
}

export const outputNoteId = (runId: string, callId: string) => `${WORK_NOTE_PREFIX}${runId}:out:${callId}`;

/** Ajusta a saída de uma tool à página: inteira se couber; senão guarda tudo no caderno e devolve página + ponteiro. */
export async function fitOutput(input: { store: Store; ownerId: string; runId: string; callId: string; toolName: string; text: string; pageChars: number }): Promise<string> {
	if (input.text.length <= input.pageChars || input.toolName === NOTE_READ_TOOL) return input.text;
	const id = outputNoteId(input.runId, input.callId);
	await input.store.notes.save({ id, userId: input.ownerId, title: `Output of ${input.toolName}`, body: input.text, pinned: false });
	const page = pageOf(input.text, 0, input.pageChars);
	return `${page.text}\n\n${pointerText(id, page)}`;
}

export function createNoteReadTool(pageChars: number): Tool {
	return defineTool({
		name: NOTE_READ_TOOL,
		description:
			"Read a work note in pages. Use it when a tool output or an earlier part of the conversation was saved to a note (the pointer in the text gives the id and the next offset). Do not use it for the owner's own notes.",
		inputSchema: z.object({ id: z.string().describe("Work note id from a pointer."), offset: z.number().int().min(0).optional().describe("Character offset to start from; default 0.") }),
		effect: "read",
		execute: async ({ id, offset }, ctx) => {
			// Só as notas de trabalho DESTE run: as de outro run (ou do dono) não se leem por aqui.
			if (!id.startsWith(`${WORK_NOTE_PREFIX}${ctx.runId}:`)) return { ok: false, error: `"${id}" is not a work note of this run.`, hint: `Work note ids of this run start with "${WORK_NOTE_PREFIX}${ctx.runId}:" and come from a pointer.` };
			const start = Math.max(0, Math.floor(offset ?? 0));
			const part = await readNoteRange(ctx.ports.store.notes, ctx.ownerId, id, start, pageChars);
			if (!part) return { ok: false, error: `Work note "${id}" was not found.`, hint: "Use the id exactly as the pointer shows it." };
			const page = pageOfRange(part, start);
			if (page.text.length === 0 && part.total > 0) return { ok: false, error: `Offset ${offset} is past the end (${part.total} characters).` };
			return { ok: true, summary: `${page.text.length > 0 ? page.text : "(empty note)"}\n\n${pointerText(id, page)}` };
		},
	});
}
