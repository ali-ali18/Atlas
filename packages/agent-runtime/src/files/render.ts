import { FILE_MAX_BYTES, mimeForExtension, type CreateFileInput } from "@workspace/shared";
import { abntMarkdownToDocx } from "./abnt-docx.js";
import { buildAbntPdfHtml } from "./abnt-pdf.js";
import { markdownToDocx } from "./markdown-to-docx.js";
import { renderPdf, type PrintPdf } from "./pdf.js";
import { renderPptx } from "./pptx.js";
import { renderXlsx } from "./xlsx.js";

export type RenderedFile = { bytes: Uint8Array; mime: string; ext: string };

export type RenderDeps = { printPdf?: PrintPdf };

/** Converte os args já validados de `create_file` nos bytes do arquivo (só o PDF usa I/O, injetado). */
export async function renderFile(input: CreateFileInput, deps: RenderDeps = {}): Promise<RenderedFile> {
	let bytes: Uint8Array;
	switch (input.format) {
		case "docx":
			bytes =
				input.layout === "abnt"
					? await abntMarkdownToDocx(input.content ?? "", input.title)
					: await markdownToDocx(input.content ?? "", input.title);
			break;
		case "xlsx":
			bytes = await renderXlsx(input.sheets ?? []);
			break;
		case "pptx":
			bytes = await renderPptx(input.slides ?? [], input.title);
			break;
		case "pdf": {
			if (!deps.printPdf) throw new Error("PDF generation is not available on this server (no PDF printer configured).");
			bytes =
				input.layout === "abnt"
					? await deps.printPdf(buildAbntPdfHtml(input.content ?? "", { title: input.title, css: input.css }))
					: await renderPdf(input.content ?? "", deps.printPdf, { title: input.title, css: input.css });
			break;
		}
		default:
			bytes = new TextEncoder().encode(input.content ?? "");
	}
	if (bytes.byteLength > FILE_MAX_BYTES) {
		throw new Error(`Generated file is too large (${Math.round(bytes.byteLength / 1024 / 1024)} MB, max 20 MB).`);
	}
	return { bytes, mime: mimeForExtension(input.ext), ext: input.ext };
}
