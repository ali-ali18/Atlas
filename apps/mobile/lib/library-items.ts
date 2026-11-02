// Itens da Biblioteca: documentos e painéis numa lista só. Funções puras (a tela e os testes usam as mesmas).
import type { LibraryFile, LibraryPanel } from "./library-api";

export type LibraryItemKind = "panel" | "document" | "sheet" | "presentation" | "image" | "file";

export type LibraryItem = { key: string; source: "file" | "panel"; id: string; kind: LibraryItemKind; title: string; date: string };

const SHEET = /(spreadsheet|ms-excel|\.sheet|\/csv$)/i;
const PRESENTATION = /(presentation|powerpoint)/i;
const DOCUMENT = /(\/pdf$|wordprocessing|msword|opendocument\.text|\/rtf$|^text\/|markdown|\/json$|\/xml$)/i;
const EXTENSIONS: Record<string, LibraryItemKind> = { pdf: "document", doc: "document", docx: "document", odt: "document", rtf: "document", txt: "document", md: "document", xls: "sheet", xlsx: "sheet", csv: "sheet", ods: "sheet", ppt: "presentation", pptx: "presentation", png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image" };

/** Tipo do item pelo mime (o nome do arquivo só desempata quando o mime é genérico, como `application/octet-stream`). */
export function libraryItemKind(mime: string, filename = ""): LibraryItemKind {
	const type = mime.trim().toLowerCase();
	if (type.startsWith("image/")) return "image";
	if (SHEET.test(type)) return "sheet";
	if (PRESENTATION.test(type)) return "presentation";
	if (DOCUMENT.test(type)) return "document";
	const extension = filename.includes(".") ? filename.split(".").pop()?.toLowerCase() : undefined;
	return (extension && EXTENSIONS[extension]) || "file";
}

const KIND_LABEL: Record<LibraryItemKind, string> = { panel: "Painel", document: "Documento", sheet: "Planilha", presentation: "Apresentação", image: "Imagem", file: "Arquivo" };

export function libraryKindLabel(kind: LibraryItemKind): string {
	return KIND_LABEL[kind];
}

const time = (iso: string) => {
	const value = new Date(iso).getTime();
	return Number.isNaN(value) ? Number.NEGATIVE_INFINITY : value;
};

/** Documentos + painéis, mais novos primeiro; data inválida vai para o fim. A ordem é estável entre empates. */
export function mergeLibraryItems(files: readonly LibraryFile[], panels: readonly LibraryPanel[]): LibraryItem[] {
	const items: LibraryItem[] = [
		...panels.map((panel): LibraryItem => ({ key: `panel:${panel.id}`, source: "panel", id: panel.id, kind: "panel", title: panel.title, date: panel.updatedAt })),
		...files.map((file): LibraryItem => ({ key: `file:${file.id}`, source: "file", id: file.id, kind: libraryItemKind(file.mime, file.filename), title: file.filename, date: file.createdAt })),
	];
	return items.sort((a, b) => time(b.date) - time(a.date));
}
