import type { TocHeading } from "./abnt.js";

export type OutlineEntry = { title: string; page: number };

function normalize(text: string): string {
	return text.normalize("NFC").toLocaleLowerCase("pt-BR").replace(/\s+/g, " ").trim();
}

/**
 * Casa os títulos do sumário, em ordem, com o contorno (bookmarks) do PDF e devolve a página exibida de cada um:
 * página física - `offset` (1 quando há capa, que não é contada). `undefined` se algum título não for achado.
 */
export function matchHeadingPages(outline: OutlineEntry[], headings: TocHeading[], offset: number): number[] | undefined {
	const pages: number[] = [];
	let cursor = 0;
	for (const heading of headings) {
		const wanted = normalize(heading.text);
		let found = -1;
		for (let i = cursor; i < outline.length; i += 1) {
			if (normalize(outline[i]!.title) === wanted) {
				found = i;
				break;
			}
		}
		if (found < 0) return undefined;
		pages.push(Math.max(1, outline[found]!.page - offset));
		cursor = found + 1;
	}
	return pages;
}

type PdfOutlineItem = { title: string; dest: string | unknown[] | null; items?: PdfOutlineItem[] };

/** Lê o contorno do PDF (gerado pelo Chromium com `outline`) e devolve a página (1-based) de cada título, na ordem do documento. */
export async function readPdfOutline(pdf: Uint8Array): Promise<OutlineEntry[]> {
	const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
	const task = getDocument({ data: new Uint8Array(pdf), useSystemFonts: false, disableFontFace: true, stopAtErrors: false, verbosity: 0 });
	try {
		const doc = await task.promise;
		const items = ((await doc.getOutline()) ?? []) as PdfOutlineItem[];
		const out: OutlineEntry[] = [];
		const walk = async (list: PdfOutlineItem[]): Promise<void> => {
			for (const item of list) {
				let dest = item.dest;
				if (typeof dest === "string") dest = (await doc.getDestination(dest)) as unknown[] | null;
				if (Array.isArray(dest) && dest[0] !== undefined && dest[0] !== null) {
					const ref = dest[0];
					const index = typeof ref === "object" ? await doc.getPageIndex(ref as Parameters<typeof doc.getPageIndex>[0]) : Number(ref);
					out.push({ title: item.title, page: index + 1 });
				}
				if (item.items?.length) await walk(item.items);
			}
		};
		await walk(items);
		return out;
	} finally {
		await task.destroy().catch(() => undefined);
	}
}

/** Página exibida de cada título do sumário medida num PDF já impresso; `undefined` se não der para medir. */
export async function measureHeadingPages(pdf: Uint8Array, headings: TocHeading[], hasCover: boolean): Promise<number[] | undefined> {
	try {
		return matchHeadingPages(await readPdfOutline(pdf), headings, hasCover ? 1 : 0);
	} catch {
		return undefined;
	}
}
