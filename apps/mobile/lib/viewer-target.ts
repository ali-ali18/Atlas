// O que a folha de conteúdo abre: um painel ou um documento. Funções puras que decidem o destino do toque (cartão do
// chat, linha da Biblioteca); quem não tem destino nativo continua no navegador.
import type { ChatItem } from "./chat-types";
import type { FileTarget } from "./file-api";
import type { LibraryItem } from "./library-items";

export type ViewerTarget = { kind: "page"; id: string; title: string } | ({ kind: "file" } & FileTarget);

type WebCard = Extract<ChatItem, { kind: "web-card" }>;

/** Painel com `pageId` ou arquivo com `fileId` abrem a folha; o resto (e cartão gravado antes de o app guardar o id) é null. */
export function viewerTargetForCard(item: WebCard): ViewerTarget | null {
	if (item.card === "page" && item.pageId) return { kind: "page", id: item.pageId, title: item.title };
	if (item.card === "file" && item.fileId) return { kind: "file", id: item.fileId, filename: item.title, ...(item.mime ? { mime: item.mime } : {}), ...(item.size !== undefined ? { size: item.size } : {}) };
	return null;
}

/** Toque numa linha da Biblioteca: painel e documento abrem a folha (nenhum vai mais para o navegador). */
export function viewerTargetForLibraryItem(item: LibraryItem): ViewerTarget {
	if (item.source === "panel") return { kind: "page", id: item.id, title: item.title };
	return { kind: "file", id: item.id, filename: item.title, ...(item.mime ? { mime: item.mime } : {}), ...(item.size !== undefined ? { size: item.size } : {}) };
}
