// `attachment_list` (F9): os anexos da conversa do dono, ou as entradas de um zip/docx/xlsx pelo id. Nada é extraído.
import { formatFileSize } from "@workspace/shared";
import { z } from "zod";
import type { AttachmentsPort } from "../../ports/attachments.js";
import { defineTool } from "../../tools/define-tool.js";
import { ATTACHMENT_LIST_PAGE, KIND_LABEL, isArchiveKind } from "./paging.js";
import { ATTACHMENT_NOT_FOUND, idField } from "./shared.js";

export function createAttachmentListTool(port: AttachmentsPort) {
	return defineTool({
		name: "attachment_list",
		description:
			"List the files the owner attached in this conversation: name, type, size and id. With the id of a zip, docx or xlsx file, list its entries (name, size) instead, without extracting anything. " +
			"Use it to find an id before attachment_read. Do not use it to read content.",
		inputSchema: z.object({
			id: idField.optional().describe("Attachment id, to list the entries of an archive."),
			offset: z.number().int().min(0).max(100_000).optional().describe("First entry to show (archives only)."),
		}),
		effect: "read",
		trust: "untrusted",
		source: "file",
		privateData: true,
		ownerData: "file",
		async execute({ id, offset }, ctx) {
			if (id === undefined) {
				const files = await port.list(ctx.ownerId);
				if (files.length === 0) return { ok: true, summary: "The owner has not attached any files in this conversation." };
				return { ok: true, summary: files.map((ref, index) => `${index + 1}. "${ref.filename}" - ${KIND_LABEL[ref.kind]}, ${formatFileSize(ref.size)}, id ${ref.id}`).join("\n") };
			}
			const file = await port.open(ctx.ownerId, id);
			if (!file) throw new Error(ATTACHMENT_NOT_FOUND);
			const { ref } = file;
			if (!isArchiveKind(ref.kind)) return { ok: true, summary: `"${ref.filename}" - ${KIND_LABEL[ref.kind]}, ${formatFileSize(ref.size)}. It is not an archive; read it with attachment_read.` };
			const listing = await file.archive();
			if (!listing) throw new Error(`"${ref.filename}" could not be opened as an archive.`);
			if (listing.unsafeReason) throw new Error(`This archive looks unsafe to open (${listing.unsafeReason}); its entries are not listed.`);
			const start = offset ?? 0;
			const page = listing.entries.slice(start, start + ATTACHMENT_LIST_PAGE);
			const end = start + page.length;
			const rows = page.map((entry) => `${entry.isDir ? "d" : "-"} ${String(entry.size).padStart(10)}  ${entry.name}`);
			const more = end < listing.entries.length ? `; next: attachment_list with id "${ref.id}" and offset ${end}` : "";
			const truncated = listing.truncated ? " (listing truncated)" : "";
			return {
				ok: true,
				summary: `"${ref.filename}" (id ${ref.id}): ${listing.entries.length} entries, ${formatFileSize(listing.totalSize)} uncompressed${truncated}. Showing ${start + 1}-${end}${more}.\n${rows.join("\n")}`,
			};
		},
	});
}
