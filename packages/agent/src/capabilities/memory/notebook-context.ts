// Trecho do `[context]` com os títulos fixados do caderno (F5.1). O corpo da nota nunca entra aqui: lê-se sob demanda
// (`note_get`); o resto do caderno, por busca (`note_search`). Sem nota fixada não há trecho e o prompt não cresce
// (guarda de economia). O teto técnico (20 títulos, 1.800 caracteres) está em `renderPinnedNotesContext`.
import { renderPinnedNotesContext } from "@workspace/shared";
import type { Notebook } from "../../ports/notebook.js";

/** Falha ao ler o caderno nunca derruba o run: sem o trecho, o modelo ainda acha as notas por `note_search`. */
export async function pinnedNotesSection(notebook: Notebook, ownerId: string): Promise<string | null> {
	try {
		return renderPinnedNotesContext(await notebook.listPinned(ownerId));
	} catch {
		return null;
	}
}
