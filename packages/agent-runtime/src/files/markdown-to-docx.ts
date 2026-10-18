import {
	AlignmentType,
	BorderStyle,
	Document,
	HeadingLevel,
	LevelFormat,
	Packer,
	Paragraph,
	Table,
	TableCell,
	TableRow,
	TextRun,
	WidthType,
	type ParagraphChild,
} from "docx";
import { Lexer, type Token, type Tokens } from "marked";

const HEADINGS = [
	HeadingLevel.HEADING_1,
	HeadingLevel.HEADING_2,
	HeadingLevel.HEADING_3,
	HeadingLevel.HEADING_4,
	HeadingLevel.HEADING_5,
	HeadingLevel.HEADING_6,
] as const;

type Style = { bold?: boolean; italics?: boolean; code?: boolean; strike?: boolean };

function decodeEntities(text: string): string {
	return text
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&");
}

function textRun(text: string, style: Style): TextRun {
	return new TextRun({
		text,
		bold: style.bold,
		italics: style.italics,
		strike: style.strike,
		...(style.code ? { font: "Consolas" } : {}),
	});
}

function inlineRuns(tokens: Token[] | undefined, style: Style = {}): ParagraphChild[] {
	const runs: ParagraphChild[] = [];
	for (const token of tokens ?? []) {
		switch (token.type) {
			case "strong":
				runs.push(...inlineRuns((token as Tokens.Strong).tokens, { ...style, bold: true }));
				break;
			case "em":
				runs.push(...inlineRuns((token as Tokens.Em).tokens, { ...style, italics: true }));
				break;
			case "del":
				runs.push(...inlineRuns((token as Tokens.Del).tokens, { ...style, strike: true }));
				break;
			case "codespan":
				runs.push(textRun(decodeEntities((token as Tokens.Codespan).text), { ...style, code: true }));
				break;
			case "br":
				runs.push(new TextRun({ break: 1 }));
				break;
			case "link": {
				const link = token as Tokens.Link;
				runs.push(...inlineRuns(link.tokens, style));
				if (link.href && /^(https?:|mailto:)/i.test(link.href)) runs.push(textRun(` (${link.href})`, style));
				break;
			}
			case "image":
				runs.push(textRun((token as Tokens.Image).text || "", style));
				break;
			default: {
				const t = token as { text?: string; tokens?: Token[] };
				if (t.tokens) runs.push(...inlineRuns(t.tokens, style));
				else if (typeof t.text === "string") runs.push(textRun(decodeEntities(t.text), style));
			}
		}
	}
	return runs;
}

function listParagraphs(list: Tokens.List, level: number): Paragraph[] {
	const out: Paragraph[] = [];
	for (const item of list.items) {
		const inline: Token[] = [];
		const nested: Token[] = [];
		for (const child of item.tokens) {
			if (child.type === "list") nested.push(child);
			else if (child.type === "text" || child.type === "paragraph") {
				const t = child as Tokens.Text;
				inline.push(...(t.tokens ?? [child]));
			} else nested.push(child);
		}
		out.push(
			new Paragraph({
				children: inlineRuns(inline),
				...(list.ordered
					? { numbering: { reference: "ordered", level: Math.min(level, 4) } }
					: { bullet: { level: Math.min(level, 4) } }),
			}),
		);
		for (const child of nested) out.push(...(blockToDocx(child, level + 1) as Paragraph[]));
	}
	return out;
}

const CELL_BORDER = { style: BorderStyle.SINGLE, size: 4, color: "BBBBBB" };
const BORDERS = { top: CELL_BORDER, bottom: CELL_BORDER, left: CELL_BORDER, right: CELL_BORDER };

function tableToDocx(token: Tokens.Table): Table {
	const row = (cells: Tokens.TableCell[], header: boolean) =>
		new TableRow({
			tableHeader: header,
			children: cells.map(
				(cell) =>
					new TableCell({
						borders: BORDERS,
						shading: header ? { fill: "EEEEEE" } : undefined,
						children: [new Paragraph({ children: inlineRuns(cell.tokens, header ? { bold: true } : {}) })],
					}),
			),
		});
	return new Table({
		width: { size: 100, type: WidthType.PERCENTAGE },
		rows: [row(token.header, true), ...token.rows.map((r) => row(r, false))],
	});
}

function blockToDocx(token: Token, level = 0): Array<Paragraph | Table> {
	switch (token.type) {
		case "heading": {
			const h = token as Tokens.Heading;
			return [new Paragraph({ heading: HEADINGS[Math.min(h.depth, 6) - 1], children: inlineRuns(h.tokens) })];
		}
		case "paragraph":
			return [new Paragraph({ children: inlineRuns((token as Tokens.Paragraph).tokens), spacing: { after: 120 } })];
		case "text": {
			const t = token as Tokens.Text;
			return [new Paragraph({ children: inlineRuns(t.tokens ?? [token]) })];
		}
		case "list":
			return listParagraphs(token as Tokens.List, level);
		case "table":
			return [tableToDocx(token as Tokens.Table), new Paragraph({ children: [] })];
		case "code":
			return (token as Tokens.Code).text.split("\n").map(
				(line) =>
					new Paragraph({
						children: [new TextRun({ text: line, font: "Consolas", size: 20 })],
						shading: { fill: "F4F4F4" },
					}),
			);
		case "blockquote":
			return (token as Tokens.Blockquote).tokens.flatMap((child) =>
				child.type === "paragraph"
					? [
							new Paragraph({
								children: inlineRuns((child as Tokens.Paragraph).tokens, { italics: true }),
								indent: { left: 540 },
							}),
						]
					: blockToDocx(child, level),
			);
		case "hr":
			return [new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "999999", space: 1 } } })];
		case "space":
		case "html":
			return [];
		default: {
			const t = token as { text?: string };
			return typeof t.text === "string" ? [new Paragraph({ children: [new TextRun(t.text)] })] : [];
		}
	}
}

/** Markdown simples (títulos, listas, tabelas, negrito/itálico, código) para .docx. */
export async function markdownToDocx(markdown: string, title?: string): Promise<Uint8Array> {
	const tokens = new Lexer().lex(markdown);
	const children: Array<Paragraph | Table> = [];
	if (title) {
		children.push(
			new Paragraph({ heading: HeadingLevel.TITLE, alignment: AlignmentType.LEFT, children: [new TextRun(title)] }),
		);
	}
	for (const token of tokens) children.push(...blockToDocx(token));
	if (children.length === 0) children.push(new Paragraph({ children: [] }));
	const doc = new Document({
		title: title ?? undefined,
		creator: "Atlas",
		numbering: {
			config: [
				{
					reference: "ordered",
					levels: Array.from({ length: 5 }, (_, level) => ({
						level,
						format: LevelFormat.DECIMAL,
						text: `%${level + 1}.`,
						alignment: AlignmentType.START,
						style: { paragraph: { indent: { left: 720 + level * 360, hanging: 360 } } },
					})),
				},
			],
		},
		sections: [{ children }],
	});
	return new Uint8Array(await Packer.toBuffer(doc));
}
