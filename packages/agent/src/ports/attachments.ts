// Porta `Attachments` (F9, anexos no v4): os arquivos que o dono enviou NESTA conversa, lidos sem executar nada.
// O adaptador do worker liga a porta ao cache de extração do run (texto, tabelas e avisos) e aos bytes do armazenamento.
// Escopo: todo método recebe o `ownerId` do run (nunca do modelo). Arquivo de outro dono ou de outra conversa = `null`.
import type { AttachmentKind } from "@workspace/shared";

export type AttachmentRef = { id: string; filename: string; mime: string; size: number; kind: AttachmentKind };

/** Planilha ou CSV: as linhas guardadas (a primeira costuma ser o cabeçalho) e o tamanho total. */
export type AttachmentSheet = { name: string; rows: string[][]; totalRows: number; totalCols: number; rowsCut: boolean; colsCut: boolean };

/** Conteúdo já extraído do arquivo (cache do run): texto corrido, tabelas e avisos para o modelo. */
export type AttachmentContent = { text: string; textCut: boolean; tables: readonly AttachmentSheet[]; notes: readonly string[] };

export type ArchiveEntry = { name: string; size: number; isDir: boolean };
/** Diretório central de um zip (docx e xlsx também são zip): listado sem extrair nada. */
export type ArchiveListing = { entries: readonly ArchiveEntry[]; totalSize: number; truncated: boolean; unsafeReason: string | null };

export type AttachmentFile = {
	ref: AttachmentRef;
	content: AttachmentContent;
	/** Bytes originais. Lança se o arquivo sumiu do armazenamento. */
	bytes(): Promise<Uint8Array>;
	/** Entradas do zip; `null` quando o arquivo não é zip (nem docx/xlsx). */
	archive(): Promise<ArchiveListing | null>;
	/**
	 * Bytes de UMA entrada, pelo nome como a listagem mostra. `null` = a entrada não existe. Lança com o motivo quando a
	 * entrada é pasta, passa de `maxBytes` ou o zip está corrompido (nunca corta em silêncio).
	 */
	archiveEntry(name: string, maxBytes: number): Promise<Uint8Array | null>;
};

export interface AttachmentsPort {
	/** Anexos do dono nesta conversa, do mais antigo ao mais novo. */
	list(ownerId: string): Promise<AttachmentRef[]>;
	/** `null` = não é um anexo deste dono nesta conversa (inexistente e de outro dono dão o mesmo resultado). */
	open(ownerId: string, id: string): Promise<AttachmentFile | null>;
}
