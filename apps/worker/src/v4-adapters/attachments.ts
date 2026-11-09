// Porta `Attachments` do v4 no worker (F9): os arquivos que o dono enviou NA conversa, lidos pelo cache de extração do run
// (o mesmo do motor atual: texto, tabelas e avisos) e pelos bytes do armazenamento. Zip é lido aqui, com `@workspace/files/zip`.
//
// ESCOPO: o dono e a conversa vêm da montagem do run (`scope`), nunca do modelo. Arquivo de outro dono, de outra conversa ou
// inexistente dão o mesmo `null`. A fonte (`runtime` do run) já vem filtrada por dono e conversa; aqui se confere de novo.
//
// Sem `@workspace/agent-runtime`: a fonte é um tipo estrutural, o `AttachmentRuntime` que o processador já monta por run.
import type { ArchiveListing, AttachmentContent, AttachmentFile, AttachmentRef, AttachmentSheet, AttachmentsPort } from "@workspace/agent";
import { listZip, readZipEntry, safeEntryName } from "@workspace/files/zip";
import type { AttachmentKind } from "@workspace/shared";

/** Anexo como a fonte do run o descreve (mesma forma de `AttachmentRef` do motor atual). */
type SourceRef = { id: string; filename: string; mime: string; size: number; kind: AttachmentKind };

/** Conteúdo extraído do arquivo (o que o cache do run devolve). */
type SourceExtracted = { text: string; textCut: boolean; tables: readonly AttachmentSheet[]; notes: readonly string[] };

/**
 * Fonte dos anexos do run: a lista da conversa e o cache de extração. Estrutural de propósito (o `AttachmentRuntime` do
 * processador serve; este módulo não importa o agent-runtime).
 */
export type V4AttachmentsSource = {
	list(): Promise<SourceRef[]>;
	cache: {
		get(ref: SourceRef): Promise<{ extracted: SourceExtracted; bytes(): Promise<Uint8Array> } | null>;
	};
};

export type V4AttachmentsScope = { ownerId: string; conversationId: string | null };

const ARCHIVE_KINDS: ReadonlySet<AttachmentKind> = new Set<AttachmentKind>(["zip", "docx", "xlsx"]);

function toPortRef(ref: SourceRef): AttachmentRef {
	return { id: ref.id, filename: ref.filename, mime: ref.mime, size: ref.size, kind: ref.kind };
}

/** Diretório central do zip, no formato da porta (sem o nome interno da biblioteca). */
function listingOf(bytes: Uint8Array): ArchiveListing {
	const listing = listZip(bytes);
	return {
		entries: listing.entries.map((entry) => ({ name: entry.name, size: entry.size, isDir: entry.isDir })),
		totalSize: listing.totalSize,
		truncated: listing.truncated,
		unsafeReason: listing.unsafeReason,
	};
}

function fileOf(ref: SourceRef, loaded: { extracted: SourceExtracted; bytes(): Promise<Uint8Array> }): AttachmentFile {
	const content: AttachmentContent = {
		text: loaded.extracted.text,
		textCut: loaded.extracted.textCut,
		tables: loaded.extracted.tables,
		notes: loaded.extracted.notes,
	};
	return {
		ref: toPortRef(ref),
		content,
		bytes: () => loaded.bytes(),
		archive: async () => {
			if (!ARCHIVE_KINDS.has(ref.kind)) return null;
			return listingOf(await loaded.bytes());
		},
		archiveEntry: async (name, maxBytes) => {
			if (!ARCHIVE_KINDS.has(ref.kind)) return null;
			const bytes = await loaded.bytes();
			const listing = listZip(bytes);
			if (listing.unsafeReason) throw new Error(`o arquivo parece inseguro para abrir (${listing.unsafeReason})`);
			const wanted = safeEntryName(name);
			const entry = listing.entries.find((item) => item.name === wanted);
			if (!entry) return null;
			return new Uint8Array(readZipEntry(bytes, entry, maxBytes));
		},
	};
}

/** Porta `Attachments` do run: escopada ao dono e à conversa da montagem. */
export function createV4Attachments(input: { scope: V4AttachmentsScope; source: V4AttachmentsSource }): AttachmentsPort {
	const { scope, source } = input;
	return {
		async list(ownerId) {
			if (ownerId !== scope.ownerId || !scope.conversationId) return [];
			return (await source.list()).map(toPortRef);
		},
		async open(ownerId, id) {
			if (ownerId !== scope.ownerId || !scope.conversationId) return null;
			const ref = (await source.list()).find((item) => item.id === id);
			if (!ref) return null;
			const loaded = await source.cache.get(ref);
			if (!loaded) return null;
			return fileOf(ref, loaded);
		},
	};
}
