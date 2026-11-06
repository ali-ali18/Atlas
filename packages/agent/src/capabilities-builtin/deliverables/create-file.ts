import { DECK_MAX_SLIDES, DECK_THEMES, FILE_MAX_CONTENT_CHARS, FILE_TITLE_MAX_CHARS, FILE_LAYOUTS, XLSX_MAX_COLUMNS, XLSX_MAX_ROWS, XLSX_MAX_SHEETS, parseCreateFileArgs } from "@workspace/shared";
import { z } from "zod";
import type { DeliverableFiles } from "../../ports/deliverables.js";
import { defineTool } from "../../tools/define-tool.js";

/**
 * Formatos criáveis. `.html` fica de fora de propósito: o conteúdo é escrito pelo modelo (possivelmente sob taint)
 * e serviria como XSS armazenado quando o dono abrisse o arquivo (auditoria F1, S4).
 */
export const CREATABLE_EXTENSIONS = ["docx", "pdf", "xlsx", "pptx", "md", "csv", "txt", "json"] as const;
export type CreatableExtension = (typeof CREATABLE_EXTENSIONS)[number];

// Nome simples, sem pasta; a extensão precisa estar na lista acima.
export const DELIVERABLE_FILE_NAME = new RegExp(`^[^\\\\/\\u0000]{1,110}\\.(${CREATABLE_EXTENSIONS.join("|")})$`, "i");

const cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const createFileInput = z.object({
	filename: z.string().min(1).max(120).regex(DELIVERABLE_FILE_NAME, `filename must be a plain name ending in ${CREATABLE_EXTENSIONS.map((e) => `.${e}`).join(", ")} (no folders; .html is not supported)`),
	content: z.string().max(FILE_MAX_CONTENT_CHARS).optional().describe("Text or Markdown. Required for docx, pdf, md, txt, csv and json."),
	title: z.string().max(FILE_TITLE_MAX_CHARS).optional(),
	layout: z.enum(FILE_LAYOUTS).optional().describe('docx/pdf only. "abnt" formats an academic work (NBR 14724).'),
	sheets: z
		.array(z.strictObject({ name: z.string().max(60).optional(), columns: z.array(z.string()).max(XLSX_MAX_COLUMNS).optional(), rows: z.array(z.array(cell)).max(XLSX_MAX_ROWS) }))
		.min(1)
		.max(XLSX_MAX_SHEETS)
		.optional()
		.describe("xlsx only. A string starting with '=' becomes a formula."),
	slides: z.array(z.record(z.string(), z.unknown())).min(1).max(DECK_MAX_SLIDES).optional().describe("pptx only. Each slide is { layout, title, ...fields of that layout, notes? }."),
	theme: z.enum(DECK_THEMES).optional().describe("pptx only; default clean."),
	brand_color: z.string().max(9).optional().describe('pptx only. Hex such as "#1d6b3a".'),
});

type CreateFileArgs = z.output<typeof createFileInput>;

function crossFieldErrors(args: CreateFileArgs, ext: string): string[] {
	const problems: string[] = [];
	if (args.sheets && ext !== "xlsx") problems.push("sheets only applies to .xlsx files");
	if (args.slides && ext !== "pptx") problems.push("slides only applies to .pptx files");
	if ((args.theme || args.brand_color) && ext !== "pptx") problems.push("theme and brand_color only apply to .pptx files");
	if (args.layout === "abnt" && ext !== "docx" && ext !== "pdf") problems.push('layout "abnt" only applies to .docx and .pdf files');
	if (ext === "xlsx" && !args.sheets) problems.push("an .xlsx file needs sheets");
	if (ext === "pptx" && !args.slides) problems.push("a .pptx file needs slides");
	if (ext !== "xlsx" && ext !== "pptx" && args.content === undefined) problems.push(`a .${ext} file needs content`);
	if ((ext === "xlsx" || ext === "pptx") && args.content !== undefined) problems.push(`content does not apply to .${ext} files (use ${ext === "xlsx" ? "sheets" : "slides"})`);
	return problems;
}

export function createCreateFileTool(files: DeliverableFiles) {
	return defineTool({
		name: "create_file",
		description:
			"Create a file for the owner and return its receipt: Word .docx, .pdf, Excel .xlsx, PowerPoint .pptx, or plain .md/.txt/.csv/.json. Use when the owner asks for a document, spreadsheet, deck or file to keep or send. Do not paste the document in chat instead; do not use for a dashboard (create_page), a single chart (chart) or an image. Calling again with the same filename makes a new version.",
		inputSchema: createFileInput,
		effect: "write_internal",
		riskFacts: ({ filename }) => ({ target: filename }),
		async execute(args, ctx) {
			const ext = args.filename.slice(args.filename.lastIndexOf(".") + 1).toLowerCase();
			const problems = crossFieldErrors(args, ext);
			if (problems.length > 0) throw new Error(`Invalid file request: ${problems.join("; ")}.`);
			const { filename, ...rest } = args;
			const input = parseCreateFileArgs({ filename, ...Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)) });
			// Defesa em profundidade: o parser aceita outras extensões de texto (incluindo html); aqui só a lista fechada.
			if (!(CREATABLE_EXTENSIONS as readonly string[]).includes(input.ext)) throw new Error(`Files of type .${input.ext} are not supported.`);
			const stored = await files.create(ctx.ownerId, ctx.runId, input);
			const version = stored.version && stored.version > 1 ? ` (version ${stored.version})` : "";
			return {
				ok: true,
				summary: `Created ${stored.name}${version}, ${stored.bytes} bytes.`,
				receipt: { what: `Created file ${stored.name}${version}`, where: stored.name, externalId: stored.id, ...(stored.url && { url: stored.url }) },
			};
		},
	});
}
