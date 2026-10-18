import type { AttachmentKind } from "@workspace/shared";
import type { ZipListing } from "./zip.js";

/** Tipos, limites e formatação leve da extração. Sem parsers: seguro de importar em qualquer processo. */

export const EXTRACT_LIMITS = {
	timeoutMs: 25_000,
	/** Texto guardado em memória por anexo (o resto é descartado com aviso). */
	maxTextChars: 1_500_000,
	maxSheets: 20,
	maxRowsKept: 20_000,
	maxCols: 100,
	maxCellChars: 1_000,
	/** docx/xlsx abertos só se o zip por dentro for razoável. */
	maxOfficeUncompressedBytes: 200 * 1024 * 1024,
} as const;

export type SheetTable = {
	name: string;
	/** Linhas guardadas (a primeira costuma ser o cabeçalho). */
	rows: string[][];
	totalRows: number;
	totalCols: number;
	/** `totalRows` passou do que foi guardado. */
	rowsCut: boolean;
	colsCut: boolean;
};

export type ExtractedAttachment = {
	kind: AttachmentKind;
	/** Texto corrido (pdf/docx/texto); vazio para planilha, zip e binário. */
	text: string;
	tables: SheetTable[];
	/** PDF: páginas lidas / total. */
	pagesRead?: number;
	pageCount?: number;
	/** O texto foi cortado na extração (não só no contexto). */
	textCut: boolean;
	/** Entradas do zip. */
	zip?: ZipListing;
	/** Avisos para o modelo (arquivo protegido, escaneado, falhou...). */
	notes: string[];
};

/** Sobe quando o formato do resultado extraído muda (invalida o cache em disco). */
export const EXTRACT_CACHE_VERSION = 1;

/** Por que a leitura do arquivo foi interrompida pelo pool (não é erro de parse: o arquivo foi morto). */
export type ExtractFailure = "timeout" | "memory" | "crash";

export type ExtractInput = { filename: string; kind: AttachmentKind; bytes: Uint8Array };
export type ExtractOutcome = { extracted: ExtractedAttachment; failure?: ExtractFailure };

/** Quem sabe ler anexos. Em produção é o pool de worker threads; testes podem injetar outro. */
export type Extractor = {
	extract(input: ExtractInput): Promise<ExtractOutcome>;
	/** Páginas do PDF sem extrair texto; `null` = ilegível, protegido ou morto por limite. */
	pageCount(bytes: Uint8Array): Promise<number | null>;
};

/** Tabela como markdown (cabeçalho + linhas), com `|` escapado. */
export function tableToMarkdown(rows: string[][]): string {
	if (rows.length === 0) return "(empty)";
	const width = Math.max(...rows.map((row) => row.length), 1);
	const esc = (value: string) => value.replace(/\|/g, "\\|");
	const pad = (row: string[]) => Array.from({ length: width }, (_, index) => esc(row[index] ?? ""));
	const [head, ...body] = rows;
	return [`| ${pad(head!).join(" | ")} |`, `| ${Array.from({ length: width }, () => "---").join(" | ")} |`, ...body.map((row) => `| ${pad(row).join(" | ")} |`)].join("\n");
}
