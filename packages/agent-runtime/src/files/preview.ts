import type ExcelJS from "exceljs";
import sanitizeHtml from "sanitize-html";
import {
	type FilePreview,
	type SheetPreview,
	PREVIEW_MAX_ROWS,
	PREVIEW_MAX_TEXT_CHARS,
	fileExtension,
	languageForExtension,
	previewKindForExtension,
} from "@workspace/shared";

export type { FilePreview, SheetPreview };

const DOCX_HTML: sanitizeHtml.IOptions = {
	allowedTags: [
		"h1", "h2", "h3", "h4", "h5", "h6", "p", "br", "strong", "b", "em", "i", "u", "s", "sub", "sup",
		"ul", "ol", "li", "table", "thead", "tbody", "tr", "th", "td", "blockquote", "pre", "code", "a", "img", "hr",
	],
	allowedAttributes: { a: ["href"], img: ["src", "alt"], td: ["colspan", "rowspan"], th: ["colspan", "rowspan"] },
	allowedSchemes: ["http", "https", "mailto"],
	allowedSchemesByTag: { img: ["data"] },
};

function cellText(value: ExcelJS.CellValue): string {
	if (value === null || value === undefined) return "";
	if (value instanceof Date) return value.toISOString();
	if (typeof value === "object") {
		if ("result" in value && value.result !== undefined) return cellText(value.result as ExcelJS.CellValue);
		if ("formula" in value) return `=${value.formula}`;
		if ("richText" in value) return value.richText.map((part) => part.text).join("");
		if ("text" in value) return String(value.text);
		if ("error" in value) return String(value.error);
		return "";
	}
	return String(value);
}

async function xlsxPreview(bytes: Uint8Array): Promise<FilePreview> {
	const { default: ExcelJSRuntime } = await import("exceljs");
	const workbook = new ExcelJSRuntime.Workbook();
	await workbook.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer);
	const sheets: SheetPreview[] = [];
	workbook.eachSheet((sheet) => {
		const rows: string[][] = [];
		let truncated = false;
		sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
			if (rowNumber > PREVIEW_MAX_ROWS) {
				truncated = true;
				return;
			}
			const cells: string[] = [];
			for (let col = 1; col <= sheet.columnCount; col++) cells.push(cellText(row.getCell(col).value));
			rows.push(cells);
		});
		sheets.push({ name: sheet.name, rows, truncated });
	});
	return { kind: "sheets", sheets };
}

/** CSV/TSV simples (aspas duplas, vírgula/tab/;) para a tabela da prévia. */
export function parseDelimited(text: string, delimiter: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = "";
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]!;
		if (quoted) {
			if (ch === '"' && text[i + 1] === '"') {
				cell += '"';
				i++;
			} else if (ch === '"') quoted = false;
			else cell += ch;
		} else if (ch === '"') quoted = true;
		else if (ch === delimiter) {
			row.push(cell);
			cell = "";
		} else if (ch === "\n" || ch === "\r") {
			if (ch === "\r" && text[i + 1] === "\n") i++;
			row.push(cell);
			rows.push(row);
			row = [];
			cell = "";
			if (rows.length > PREVIEW_MAX_ROWS) return rows;
		} else cell += ch;
	}
	if (cell || row.length) {
		row.push(cell);
		rows.push(row);
	}
	return rows;
}

/** Prévia por tipo (docx/xlsx/csv/texto/pdf/imagem). Bytes e metadados vêm do artefato do dono. */
export async function buildFilePreview(input: {
	id: string;
	filename: string;
	bytes: Uint8Array;
}): Promise<FilePreview> {
	const ext = fileExtension(input.filename);
	const kind = ext === "csv" || ext === "tsv" ? "sheet" : previewKindForExtension(ext);
	const inlineUrl = `/v1/files/${encodeURIComponent(input.id)}?inline=1`;
	switch (kind) {
		case "pdf":
		case "image":
			return { kind: "url", url: inlineUrl };
		case "docx": {
			const mammoth = (await import("mammoth")).default;
			const { value } = await mammoth.convertToHtml({ buffer: Buffer.from(input.bytes) });
			return { kind: "html", html: sanitizeHtml(value, DOCX_HTML) };
		}
		case "sheet": {
			if (ext === "xlsx") return xlsxPreview(input.bytes);
			const text = new TextDecoder().decode(input.bytes.subarray(0, PREVIEW_MAX_TEXT_CHARS));
			const rows = parseDelimited(text, ext === "tsv" ? "\t" : text.includes(";") && !text.includes(",") ? ";" : ",");
			return {
				kind: "sheets",
				sheets: [{ name: input.filename, rows: rows.slice(0, PREVIEW_MAX_ROWS), truncated: rows.length > PREVIEW_MAX_ROWS }],
			};
		}
		case "pptx":
			return { kind: "none", reason: "Prévia indisponível para apresentações. Baixe o arquivo." };
		default: {
			// Binário (zip, executável, dados): sem texto para mostrar.
			if (input.bytes.subarray(0, 8192).includes(0)) return { kind: "none", reason: "Prévia indisponível para este tipo de arquivo. Baixe o arquivo." };
			const full = new TextDecoder().decode(input.bytes);
			const truncated = full.length > PREVIEW_MAX_TEXT_CHARS;
			return {
				kind: "text",
				text: truncated ? full.slice(0, PREVIEW_MAX_TEXT_CHARS) : full,
				language: languageForExtension(ext),
				truncated,
			};
		}
	}
}
