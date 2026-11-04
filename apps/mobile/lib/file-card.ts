// Decisões puras do cartão de arquivo/documento no chat: de que tipo é (cor da faixa e ícone) e a linha cinza de baixo.
import { fileCategory, formatFileSize } from "@workspace/shared";
import { libraryItemKind, libraryKindLabel } from "./library-items";

/** Cor da faixa do ícone, sempre um token do tema (nunca hex): PDF vermelho, texto azul, planilha verde, apresentação âmbar. */
export type FileTone = "destructive" | "info" | "success" | "warning" | "muted";
export type FileGlyph = "text" | "sheet" | "presentation" | "generic";

export type FileCardKind = { tone: FileTone; glyph: FileGlyph };

/**
 * Tipo visual do cartão. A extensão manda (mesma categoria do web: `fileCategory`); sem extensão útil, o mime desempata
 * para que um documento de texto nunca caia no cinza de "arquivo qualquer".
 */
export function fileCardKind(filename: string, mime = ""): FileCardKind {
	const category = fileCategory(filename);
	if (category === "pdf") return { tone: "destructive", glyph: "text" };
	if (category === "docx") return { tone: "info", glyph: "text" };
	if (category === "sheet") return { tone: "success", glyph: "sheet" };
	if (category === "pptx") return { tone: "warning", glyph: "presentation" };
	if (category === "text" && libraryItemKind(mime, filename) === "document") return { tone: "info", glyph: "text" };
	return { tone: "muted", glyph: "generic" };
}

/** "Documento · 1,6 KB": o tipo em palavras (o mesmo da Biblioteca) e o tamanho, quando o servidor informou. */
export function fileCardSubtitle(filename: string, mime = "", size?: number): string {
	const label = libraryKindLabel(libraryItemKind(mime, filename));
	const bytes = size !== undefined ? formatFileSize(size) : "";
	return [label, bytes].filter(Boolean).join(" · ");
}
