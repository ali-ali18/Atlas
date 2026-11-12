// `attachment_to_computer` (F9): copia um anexo (ou uma entrada de zip/docx/xlsx) para a pasta `anexos` do computador do dono,
// pela porta `Sandbox` (kind `attachments.copy`). Nada é executado. Só entra no run que tem computador (VM).
import { ATTACHMENT_LIMITS, formatFileSize, sanitizeFilename } from "@workspace/shared";
import { z } from "zod";
import type { AttachmentsPort } from "../../ports/attachments.js";
import { defineTool } from "../../tools/define-tool.js";
import { ATTACHMENT_KINDS, attachmentCopyResult } from "./kinds.js";
import { isArchiveKind } from "./paging.js";
import { ATTACHMENT_NOT_FOUND, idField } from "./shared.js";

export function createAttachmentCopyTool(port: AttachmentsPort) {
	return defineTool({
		name: "attachment_to_computer",
		description:
			"Copy a file the owner attached (or one entry of a zip, docx or xlsx) into the 'anexos' folder of the owner's computer, so shell commands can unpack or process it. Returns the path. Nothing is executed. " +
			"Use it for big or binary files, or archives you must work with. For reading text, use attachment_read.",
		inputSchema: z.object({
			id: idField,
			entry: z.string().trim().min(1).max(500).optional().describe("Copy only this entry of a zip, docx or xlsx."),
			name: z.string().trim().min(1).max(200).optional().describe("File name at the destination (default: the original name)."),
		}),
		// O resultado é só o caminho: o conteúdo do anexo vai à VM, não volta ao modelo (por isso não é `privateData`).
		effect: "write_internal",
		trust: "untrusted",
		source: "file",
		async execute({ id, entry, name }, ctx) {
			const file = await port.open(ctx.ownerId, id);
			if (!file) throw new Error(ATTACHMENT_NOT_FOUND);
			const { ref } = file;
			let bytes: Uint8Array;
			let defaultName = ref.filename;
			if (entry !== undefined) {
				if (!isArchiveKind(ref.kind)) throw new Error(`"${ref.filename}" is not an archive, so it has no entries to copy.`);
				const listing = await file.archive();
				if (!listing || listing.unsafeReason) throw new Error(`"${ref.filename}" could not be opened safely as an archive.`);
				const found = await file.archiveEntry(entry, ATTACHMENT_LIMITS.maxBytes);
				if (!found) throw new Error(`Entry "${entry}" not found in "${ref.filename}". List entries with attachment_list.`);
				bytes = found;
				defaultName = entry.split("/").pop() || "entry";
			} else {
				bytes = await file.bytes();
			}
			// Só o nome do último trecho, sem separadores nem `..`: a pasta é sempre `anexos`.
			const safeName = sanitizeFilename(name ?? defaultName);
			if (!safeName) throw new Error("The file name is empty after removing unsafe characters. Pass a simpler name.");
			const result = await ctx.ports.sandbox.run(ctx.ownerId, { kind: ATTACHMENT_KINDS.copy, params: { name: safeName, bytes } }, ctx.signal);
			if (!result.ok) throw new Error(result.error ?? "The file could not be copied to the computer.");
			const copied = attachmentCopyResult.safeParse(result.data);
			if (!copied.success) throw new Error("The computer did not confirm where the file was copied.");
			return {
				ok: true,
				summary: `Copied "${ref.filename}"${entry !== undefined ? ` (entry ${entry})` : ""} to ${copied.data.path} on the computer (${formatFileSize(bytes.byteLength)}). It was not executed. Work with it there with shell commands.`,
			};
		},
	});
}
