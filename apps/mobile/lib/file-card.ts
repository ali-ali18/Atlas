// Decisões puras do cartão de arquivo/documento no chat: de que tipo é (cor da faixa e ícone) e a linha cinza de baixo.
import { fileCategory, fileExtension, formatFileSize } from "@workspace/shared";
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

/** Extensão "de verdade": 1 a 5 letras/dígitos. "Relatório v1.2 final" não tem extensão (o trecho depois do ponto é frase). */
const EXTENSION = /^[a-z0-9]{1,5}$/i;

/**
 * Separa nome e extensão pelo ÚLTIMO ponto ("a.tar.gz" -> "a.tar" + "GZ"). Sem extensão válida (sem ponto, ponto só no
 * começo como ".env", ponto no fim, trecho longo ou com espaço) o nome fica inteiro e `ext` vem vazio.
 */
export function splitFileName(filename: string): { stem: string; ext: string } {
	const ext = fileExtension(filename);
	if (!ext || !EXTENSION.test(ext)) return { stem: filename, ext: "" };
	return { stem: filename.slice(0, filename.length - ext.length - 1), ext: ext.toUpperCase() };
}

/** Nome em destaque do cartão: sem a extensão (que vai na linha de baixo). */
export function fileCardTitle(filename: string): string {
	return splitFileName(filename).stem;
}

/** "PDF · 1,6 KB": a extensão em maiúsculas e o tamanho. Sem extensão, o rótulo do tipo ("Arquivo · 900 B"). */
export function fileCardSubtitle(filename: string, mime = "", size?: number): string {
	const label = splitFileName(filename).ext || libraryKindLabel(libraryItemKind(mime, filename));
	const bytes = size !== undefined ? formatFileSize(size) : "";
	return [label, bytes].filter(Boolean).join(" · ");
}
