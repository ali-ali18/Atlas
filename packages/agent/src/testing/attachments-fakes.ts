// Anexos em memória para os testes da capacidade `attachments`. Cada item tem um dono e uma conversa: outro dono não vê nada.
import type { AttachmentKind } from "@workspace/shared";
import type { ArchiveListing, AttachmentContent, AttachmentFile, AttachmentRef, AttachmentSheet, AttachmentsPort } from "../ports/attachments.js";

export type FakeAttachmentInput = {
	ownerId: string;
	id: string;
	filename: string;
	kind: AttachmentKind;
	mime?: string;
	/** Texto extraído (pdf, docx, texto). */
	text?: string;
	tables?: AttachmentSheet[];
	notes?: string[];
	/** Bytes originais (binário, ou o próprio zip). */
	bytes?: Uint8Array;
	/** Entradas de um zip: nome → conteúdo. */
	entries?: Record<string, Uint8Array>;
	/** Bytes ausentes do armazenamento (o arquivo sumiu). */
	gone?: boolean;
};

const enc = (text: string) => new TextEncoder().encode(text);

export class FakeAttachments implements AttachmentsPort {
	/** Quem pediu cada anexo (teste de escopo). */
	readonly opened: Array<{ ownerId: string; id: string }> = [];
	constructor(readonly items: FakeAttachmentInput[] = []) {}

	private refOf(item: FakeAttachmentInput): AttachmentRef {
		return { id: item.id, filename: item.filename, mime: item.mime ?? "application/octet-stream", size: item.bytes?.byteLength ?? enc(item.text ?? "").byteLength, kind: item.kind };
	}

	async list(ownerId: string): Promise<AttachmentRef[]> {
		return this.items.filter((item) => item.ownerId === ownerId).map((item) => this.refOf(item));
	}

	async open(ownerId: string, id: string): Promise<AttachmentFile | null> {
		this.opened.push({ ownerId, id });
		const item = this.items.find((candidate) => candidate.ownerId === ownerId && candidate.id === id);
		if (!item) return null;
		const content: AttachmentContent = { text: item.text ?? "", textCut: false, tables: item.tables ?? [], notes: item.notes ?? [] };
		const bytesOrThrow = (): Uint8Array => {
			if (item.gone) throw new Error("file is no longer available");
			return item.bytes ?? enc(item.text ?? "");
		};
		return {
			ref: this.refOf(item),
			content,
			bytes: async () => bytesOrThrow(),
			archive: async (): Promise<ArchiveListing | null> => {
				if (!item.entries) return null;
				const entries = Object.entries(item.entries).map(([name, data]) => ({ name, size: data.byteLength, isDir: false }));
				return { entries, totalSize: entries.reduce((sum, entry) => sum + entry.size, 0), truncated: false, unsafeReason: null };
			},
			archiveEntry: async (name: string) => item.entries?.[name] ?? null,
		};
	}
}

export function sheet(name: string, rows: string[][], extra: Partial<AttachmentSheet> = {}): AttachmentSheet {
	return { name, rows, totalRows: rows.length, totalCols: Math.max(1, ...rows.map((row) => row.length)), rowsCut: false, colsCut: false, ...extra };
}

export { enc as encodeText };
