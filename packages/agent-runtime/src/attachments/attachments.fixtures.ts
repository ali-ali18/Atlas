import { deflateRawSync } from "node:zlib";
import { Document, Packer, Paragraph, TextRun } from "docx";
import ExcelJS from "exceljs";
import { extractAttachment, pdfPageCount } from "./extract-core.js";
import type { Extractor } from "./extract.js";

/** Fixtures pequenas geradas em memória para os testes de anexos (nenhum arquivo no repositório). */

export function makePdf(pages: string[]): Uint8Array {
	let pdf = "%PDF-1.4\n";
	const offsets: number[] = [];
	const add = (n: number, body: string) => {
		offsets[n] = pdf.length;
		pdf += `${n} 0 obj\n${body}\nendobj\n`;
	};
	const pageCount = pages.length;
	const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ");
	add(1, "<< /Type /Catalog /Pages 2 0 R >>");
	add(2, `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`);
	const fontId = 3 + pageCount * 2;
	pages.forEach((text, i) => {
		const pageId = 3 + i * 2;
		const contentId = pageId + 1;
		add(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`);
		const stream = text ? `BT /F1 14 Tf 20 100 Td (${text.replace(/[()\\]/g, "")}) Tj ET` : "";
		add(contentId, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
	});
	add(fontId, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
	const xref = pdf.length;
	const total = fontId + 1;
	pdf += `xref\n0 ${total}\n0000000000 65535 f \n`;
	for (let n = 1; n < total; n += 1) pdf += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
	pdf += `trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
	return new Uint8Array(Buffer.from(pdf, "latin1"));
}

export async function makeDocx(paragraphs: string[]): Promise<Uint8Array> {
	const doc = new Document({
		sections: [{ children: paragraphs.map((text) => new Paragraph({ children: [new TextRun(text)] })) }],
	});
	return new Uint8Array(await Packer.toBuffer(doc));
}

export async function makeXlsx(sheets: Array<{ name: string; rows: Array<Array<string | number>> }>): Promise<Uint8Array> {
	const workbook = new ExcelJS.Workbook();
	for (const sheet of sheets) {
		const ws = workbook.addWorksheet(sheet.name);
		for (const row of sheet.rows) ws.addRow(row);
	}
	return new Uint8Array(await workbook.xlsx.writeBuffer());
}

function crc32(data: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of data) {
		crc ^= byte;
		for (let k = 0; k < 8; k += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
	}
	return (crc ^ 0xffffffff) >>> 0;
}

/** Zip válido (deflate ou stored) com as entradas dadas. */
export function makeZip(entries: Array<{ name: string; data: Uint8Array | string; stored?: boolean }>): Uint8Array {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const entry of entries) {
		const data = typeof entry.data === "string" ? Buffer.from(entry.data) : Buffer.from(entry.data);
		const name = Buffer.from(entry.name);
		const body = entry.stored ? data : deflateRawSync(data);
		const method = entry.stored ? 0 : 8;
		const crc = crc32(data);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(method, 8);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(body.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(name.length, 26);
		locals.push(local, name, body);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(method, 10);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(body.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE(offset, 42);
		centrals.push(central, name);
		offset += local.length + name.length + body.length;
	}
	const centralBuffer = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(centralBuffer.length, 12);
	end.writeUInt32LE(offset, 16);
	return new Uint8Array(Buffer.concat([...locals, centralBuffer, end]));
}

/** Extrator na própria thread do teste (os testes de parsing não precisam do pool). */
export const inProcessExtractor: Extractor = {
	extract: async (input) => ({ extracted: await extractAttachment(input) }),
	pageCount: (bytes) => pdfPageCount(bytes),
};
