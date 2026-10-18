import type ExcelJS from "exceljs";
import { ATTACHMENT_LIMITS, type AttachmentKind } from "@workspace/shared";
import { EXTRACT_LIMITS, type ExtractedAttachment, type SheetTable } from "./extract.js";
import { listZip } from "./zip.js";

/**
 * Extração de texto dos anexos do usuário (parsers pesados), só em memória. Roda sempre numa
 * worker thread do worker (ver `extract-pool.ts`), nunca no processo da API. O arquivo nunca é
 * executado: PDF/Office/planilha são lidos por parsers (pdf.js, mammoth, exceljs),
 * com teto de tamanho, de páginas/linhas/colunas e de tempo. Falha vira nota,
 * nunca derruba o run.
 */

// mammoth ainda expõe `convertToMarkdown`, mas os tipos dele não. Import tardio: só quem extrai paga o custo.
async function mammothMarkdown(input: { buffer: Buffer }): Promise<{ value: string }> {
	const mammoth = (await import("mammoth")).default as unknown as { convertToMarkdown: (input: { buffer: Buffer }) => Promise<{ value: string }> };
	return mammoth.convertToMarkdown(input);
}

class ExtractTimeout extends Error {}

export async function withTimeout<T>(work: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => { onTimeout?.(); reject(new ExtractTimeout("tempo esgotado ao ler o arquivo")); }, ms);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function decodeText(bytes: Uint8Array): string {
	const head = bytes.subarray(0, 3);
	const body = head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? bytes.subarray(3) : bytes;
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(body);
	} catch {
		return new TextDecoder("windows-1252").decode(body);
	}
}

function clip(text: string, notes: string[]): { text: string; cut: boolean } {
	if (text.length <= EXTRACT_LIMITS.maxTextChars) return { text, cut: false };
	notes.push(`The text was cut at ${EXTRACT_LIMITS.maxTextChars} characters while reading the file.`);
	return { text: text.slice(0, EXTRACT_LIMITS.maxTextChars), cut: true };
}

function cellString(value: ExcelJS.CellValue): string {
	if (value === null || value === undefined) return "";
	if (value instanceof Date) return value.toISOString().slice(0, 19).replace("T", " ");
	if (typeof value === "object") {
		if ("result" in value && value.result !== undefined) return cellString(value.result as ExcelJS.CellValue);
		if ("richText" in value) return value.richText.map((part) => part.text).join("");
		if ("text" in value) return String(value.text);
		if ("formula" in value) return `=${value.formula}`;
		if ("error" in value) return String(value.error);
		return "";
	}
	return String(value);
}

/** Linha em cada tabela: sem quebra de linha nem barra vertical soltas. */
export function oneLine(value: string): string {
	return value.replace(/\s+/g, " ").trim().slice(0, EXTRACT_LIMITS.maxCellChars);
}

/** CSV/TSV com aspas; guarda as primeiras `maxRows` linhas e conta o total. */
export function parseDelimitedLimited(text: string, delimiter: string, maxRows: number): { rows: string[][]; totalRows: number; totalCols: number } {
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = "";
	let quoted = false;
	let total = 0;
	let cols = 0;
	let rowHasData = false;
	const endRow = () => {
		row.push(cell);
		cell = "";
		if (row.length > 1 || row[0] !== "" || rowHasData) {
			total += 1;
			cols = Math.max(cols, row.length);
			if (rows.length < maxRows) rows.push(row.slice(0, EXTRACT_LIMITS.maxCols).map(oneLine));
		}
		row = [];
		rowHasData = false;
	};
	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i]!;
		if (quoted) {
			if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
			else if (ch === '"') quoted = false;
			else cell += ch;
			continue;
		}
		if (ch === '"') { quoted = true; rowHasData = true; }
		else if (ch === delimiter) { row.push(cell); cell = ""; rowHasData = true; }
		else if (ch === "\n" || ch === "\r") {
			if (ch === "\r" && text[i + 1] === "\n") i += 1;
			endRow();
		} else {
			cell += ch;
			if (ch.trim()) rowHasData = true;
		}
	}
	if (cell || row.length) endRow();
	return { rows, totalRows: total, totalCols: cols };
}

export function detectDelimiter(text: string, filename: string): string {
	if (/\.tsv$/i.test(filename)) return "\t";
	const firstLine = text.slice(0, 4000).split(/\r?\n/, 1)[0] ?? "";
	const counts: Array<[string, number]> = [[",", 0], [";", 0], ["\t", 0], ["|", 0]];
	for (const entry of counts) entry[1] = firstLine.split(entry[0]).length - 1;
	counts.sort((a, b) => b[1] - a[1]);
	return counts[0]![1] > 0 ? counts[0]![0] : ",";
}

async function extractPdf(bytes: Uint8Array, notes: string[], state: { aborted: boolean }): Promise<Pick<ExtractedAttachment, "text" | "pagesRead" | "pageCount" | "textCut">> {
	const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
	const task = getDocument({
		data: new Uint8Array(bytes),
		useSystemFonts: false,
		disableFontFace: true,
		stopAtErrors: false,
		verbosity: 0,
	});
	try {
		const doc = await task.promise;
		const pageCount = doc.numPages;
		const limit = Math.min(pageCount, ATTACHMENT_LIMITS.pdfTextMaxPages);
		const parts: string[] = [];
		let chars = 0;
		let pagesRead = 0;
		for (let number = 1; number <= limit && !state.aborted; number += 1) {
			const page = await doc.getPage(number);
			const content = await page.getTextContent();
			let line = "";
			const lines: string[] = [];
			for (const item of content.items) {
				if (!("str" in item)) continue;
				line += item.str;
				if (item.hasEOL) { lines.push(line); line = ""; } else if (item.str && !line.endsWith(" ")) line += " ";
			}
			if (line.trim()) lines.push(line);
			const pageText = lines.map((value) => value.replace(/[ \t]+/g, " ").trim()).filter(Boolean).join("\n");
			page.cleanup();
			parts.push(`--- page ${number} ---\n${pageText}`);
			chars += pageText.length + 20;
			pagesRead = number;
			if (chars > EXTRACT_LIMITS.maxTextChars) break;
		}
		if (pagesRead < pageCount) notes.push(`Only the first ${pagesRead} of ${pageCount} pages were read.`);
		const text = parts.join("\n\n");
		const hasText = text.replace(/--- page \d+ ---/g, "").trim().length > 0;
		if (!hasText) notes.push("No text layer was found in this PDF (probably scanned images); the text may need OCR.");
		const clipped = clip(text, notes);
		return { text: clipped.text, pagesRead, pageCount, textCut: clipped.cut || pagesRead < pageCount };
	} finally {
		await task.destroy().catch(() => undefined);
	}
}

/** Páginas do PDF sem extrair texto (para decidir PDF nativo). `null` = ilegível ou protegido. */
export async function pdfPageCount(bytes: Uint8Array): Promise<number | null> {
	try {
		const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
		const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, verbosity: 0 });
		try {
			const doc = await withTimeout(task.promise, 10_000, () => void task.destroy());
			return doc.numPages;
		} finally {
			await task.destroy().catch(() => undefined);
		}
	} catch {
		return null;
	}
}

function guardOffice(bytes: Uint8Array, notes: string[]): boolean {
	const listing = listZip(bytes);
	if (listing.unsafeReason || listing.totalSize > EXTRACT_LIMITS.maxOfficeUncompressedBytes) {
		notes.push(`The file was not opened: ${listing.unsafeReason ?? "uncompressed content is too large"}.`);
		return false;
	}
	return true;
}

async function extractXlsx(bytes: Uint8Array, notes: string[]): Promise<SheetTable[]> {
	if (!guardOffice(bytes, notes)) return [];
	const { default: ExcelJSRuntime } = await import("exceljs");
	const workbook = new ExcelJSRuntime.Workbook();
	await workbook.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer);
	const tables: SheetTable[] = [];
	for (const sheet of workbook.worksheets.slice(0, EXTRACT_LIMITS.maxSheets)) {
		const totalRows = sheet.actualRowCount || sheet.rowCount;
		const totalCols = sheet.actualColumnCount || sheet.columnCount;
		const lastRow = Math.min(sheet.rowCount, EXTRACT_LIMITS.maxRowsKept + 200);
		const cols = Math.min(Math.max(totalCols, sheet.columnCount), EXTRACT_LIMITS.maxCols);
		const rows: string[][] = [];
		for (let r = 1; r <= lastRow && rows.length < EXTRACT_LIMITS.maxRowsKept; r += 1) {
			const row = sheet.getRow(r);
			if (!row.hasValues) continue;
			const cells: string[] = [];
			for (let c = 1; c <= cols; c += 1) cells.push(oneLine(cellString(row.getCell(c).value)));
			rows.push(cells);
		}
		tables.push({ name: sheet.name, rows, totalRows, totalCols, rowsCut: totalRows > rows.length, colsCut: totalCols > cols });
	}
	if (workbook.worksheets.length > EXTRACT_LIMITS.maxSheets) notes.push(`Only the first ${EXTRACT_LIMITS.maxSheets} of ${workbook.worksheets.length} sheets were read.`);
	return tables;
}

export async function extractAttachment(input: { filename: string; kind: AttachmentKind; bytes: Uint8Array; timeoutMs?: number }): Promise<ExtractedAttachment> {
	const notes: string[] = [];
	const base: ExtractedAttachment = { kind: input.kind, text: "", tables: [], textCut: false, notes };
	const timeoutMs = input.timeoutMs ?? EXTRACT_LIMITS.timeoutMs;
	try {
		switch (input.kind) {
			case "pdf": {
				const state = { aborted: false };
				const pdf = await withTimeout(extractPdf(input.bytes, notes, state), timeoutMs, () => { state.aborted = true; });
				return { ...base, ...pdf };
			}
			case "docx": {
				if (!guardOffice(input.bytes, notes)) return base;
				const result = await withTimeout(mammothMarkdown({ buffer: Buffer.from(input.bytes) }), timeoutMs);
				const clipped = clip(result.value.replace(/!\[[^\]]*\]\(data:[^)]*\)/g, "[image]").trim(), notes);
				if (!clipped.text) notes.push("The document has no readable text.");
				return { ...base, text: clipped.text, textCut: clipped.cut };
			}
			case "xlsx": {
				return { ...base, tables: await withTimeout(extractXlsx(input.bytes, notes), timeoutMs) };
			}
			case "csv": {
				const text = decodeText(input.bytes);
				const parsed = parseDelimitedLimited(text, detectDelimiter(text, input.filename), EXTRACT_LIMITS.maxRowsKept);
				return {
					...base,
					tables: [{ name: input.filename, rows: parsed.rows, totalRows: parsed.totalRows, totalCols: parsed.totalCols, rowsCut: parsed.totalRows > parsed.rows.length, colsCut: parsed.totalCols > EXTRACT_LIMITS.maxCols }],
				};
			}
			case "text": {
				const clipped = clip(decodeText(input.bytes), notes);
				return { ...base, text: clipped.text, textCut: clipped.cut };
			}
			case "zip": {
				const zip = listZip(input.bytes);
				if (zip.unsafeReason) notes.push(`This archive looks unsafe to open (${zip.unsafeReason}); entries cannot be read.`);
				return { ...base, zip };
			}
			default:
				notes.push("This is a binary file with no readable text.");
				return base;
		}
	} catch (error) {
		const reason = error instanceof ExtractTimeout ? error.message : /password|encrypted/i.test(String(error)) ? "the file is protected by a password" : "the file could not be parsed (corrupt or unsupported)";
		notes.push(`Could not read this file: ${reason}.`);
		return base;
	}
}

