// Capacidade núcleo `deliverables-lite` (mínima, F1.14): criar um arquivo de texto simples e devolver o recibo.
// Só fala com a porta `FileStore`; arquivos ricos (docx, planilha, apresentação e HTML) chegam com a F2, com sanitização.
// `.html` fica de fora da v1 de propósito: o conteúdo é escrito pelo modelo (possivelmente sob taint) e serviria
// como XSS armazenado quando o dono abrisse o arquivo (auditoria F1, S4).
import { z } from "zod";
import { defineCapability } from "../capabilities/define-capability.js";
import type { FileStore } from "../ports/file-store.js";
import { defineTool } from "../tools/define-tool.js";

export const MAX_FILE_CHARS = 200_000;
const MIME_BY_EXT: Readonly<Record<string, string>> = { md: "text/markdown", txt: "text/plain", csv: "text/csv", json: "application/json" };

export const FILE_NAME_FORMAT = /^[\w][\w .-]{0,119}\.(md|txt|csv|json)$/i;

export function createDeliverablesLiteCapability(files: FileStore) {
	const createFile = defineTool({
		name: "create_file",
		description: "Create a simple text file (.md, .txt, .csv, .json) for the owner and return its receipt. Use for notes and short documents; do not use to run code or to edit an existing file.",
		inputSchema: z.object({
			name: z.string().min(1).max(120).regex(FILE_NAME_FORMAT, "file name must be a plain name ending in .md, .txt, .csv or .json (no folders)"),
			content: z.string().max(MAX_FILE_CHARS),
		}),
		effect: "write_internal",
		riskFacts: ({ name }) => ({ target: name }),
		async execute({ name, content }, ctx) {
			const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
			const stored = await files.put(ctx.ownerId, { name, mimeType: MIME_BY_EXT[ext] ?? "text/plain", content });
			return {
				ok: true,
				summary: `Created ${stored.name} (${stored.bytes} bytes).`,
				receipt: { what: `Created file ${stored.name}`, where: stored.name, externalId: stored.id, ...(stored.url && { url: stored.url }) },
			};
		},
	});
	return defineCapability({ id: "deliverables-lite", title: "Arquivos", summary: "Create a simple text file for the owner.", core: true, tools: [createFile], cards: ["file"] });
}
