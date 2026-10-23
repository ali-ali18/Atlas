import { FILE_MAX_BYTES, mimeForExtension, type CreateFileInput } from "@workspace/shared";
import { abntMarkdownToDocx } from "./abnt-docx.js";
import { measureAbntPages, renderAbntPdf } from "./abnt-pdf.js";
import { markdownToDocx } from "./markdown-to-docx.js";
import { renderPdf, type PrintPdf, type PrintPdfOptions } from "./pdf.js";
import type { DeckImage } from "./deck/images.js";
import { renderPptx } from "./pptx.js";
import { renderXlsx } from "./xlsx.js";

export type RenderedFile = { bytes: Uint8Array; mime: string; ext: string };

export type RenderDeps = { printPdf?: PrintPdf; deckImages?: Map<string, DeckImage> };

const printWith = (deps: RenderDeps, html: string, options?: PrintPdfOptions) => deps.printPdf!(html, undefined, options);

/** Páginas do sumário do .docx, medidas num PDF interno do mesmo conteúdo; sem Chromium o Word atualiza o campo. */
async function measureDocxToc(content: string, deps: RenderDeps): Promise<number[] | undefined> {
	if (!deps.printPdf) return undefined;
	try {
		return (await measureAbntPages(content, (html, options) => printWith(deps, html, options)))?.pages;
	} catch {
		return undefined;
	}
}

/** Converte os args já validados de `create_file` nos bytes do arquivo (só o PDF usa I/O, injetado). */
export async function renderFile(input: CreateFileInput, deps: RenderDeps = {}): Promise<RenderedFile> {
	let bytes: Uint8Array;
	switch (input.format) {
		case "docx":
			bytes =
				input.layout === "abnt"
					? await abntMarkdownToDocx(input.content ?? "", input.title, { tocPages: await measureDocxToc(input.content ?? "", deps) })
					: await markdownToDocx(input.content ?? "", input.title);
			break;
		case "xlsx":
			bytes = await renderXlsx(input.sheets ?? []);
			break;
		case "pptx":
			bytes = await renderPptx(input.slides ?? [], { title: input.title, theme: input.theme, brandColor: input.brandColor, images: deps.deckImages });
			break;
		case "pdf": {
			if (!deps.printPdf) throw new Error("PDF generation is not available on this server (no PDF printer configured).");
			bytes =
				input.layout === "abnt"
					? await renderAbntPdf(input.content ?? "", (html, options) => printWith(deps, html, options), { title: input.title, css: input.css })
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
