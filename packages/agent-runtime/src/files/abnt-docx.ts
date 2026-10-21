import {
	AlignmentType,
	BorderStyle,
	Document,
	Header,
	HeadingLevel,
	HeightRule,
	ImportedXmlComponent,
	LeaderType,
	LevelFormat,
	LineRuleType,
	NumberFormat,
	Packer,
	PageNumber,
	Paragraph,
	Table,
	TableCell,
	TableLayoutType,
	TableRow,
	TabStopType,
	TextRun,
	VerticalAlign,
	WidthType,
	type ISectionOptions,
} from "docx";
import { Lexer, type Token, type Tokens } from "marked";
import { ABNT_PAGE_BREAK, ABNT_TOC, isCaptionText, isReferencesTitle, isUnnumberedTitle, parseAbntMarkdown, splitFrontZones, tocHeadings, type TocHeading } from "./abnt.js";
import { inlineRuns } from "./markdown-to-docx.js";

/** Medidas em twips (1 cm = 567): margens 3/3/2/2 cm, A4, recuos e tamanhos da NBR 14724. */
export const ABNT_DOCX = {
	page: { width: 11906, height: 16838 },
	margin: { top: 1701, left: 1701, bottom: 1134, right: 1134, header: 1134, footer: 567 },
	bodySize: 24,
	smallSize: 20,
	lineOneAndHalf: 360,
	lineSingle: 240,
	firstLine: 709,
	quoteIndent: 2268,
	titlePageNoteIndent: 4536,
	defaultFont: "Times New Roman",
} as const;

const TEXT_WIDTH = ABNT_DOCX.page.width - ABNT_DOCX.margin.left - ABNT_DOCX.margin.right;

type Mode = "front" | "pre" | "textual";
type Block = Paragraph | Table;
type Ctx = { mode: Mode; atStart: boolean; breakNext: boolean; refs: boolean; quoteIndent: number; toc?: { headings: TocHeading[]; pages?: ReadonlyArray<number> } };

const SPACING_15 = { line: ABNT_DOCX.lineOneAndHalf, lineRule: LineRuleType.AUTO, before: 0, after: 0 };
const SPACING_1 = { line: ABNT_DOCX.lineSingle, lineRule: LineRuleType.AUTO, before: 0, after: 0 };

function plain(text: string): string {
	return text.replace(/[*_`]/g, "");
}

type ParagraphOpts = ConstructorParameters<typeof Paragraph>[0] & object;

/** Cria o parágrafo aplicando a quebra de página pendente (marcador `pagebreak` ou fim da folha de rosto). */
function para(ctx: Ctx, opts: ParagraphOpts, forceBreak = false): Paragraph {
	const pageBreakBefore = ctx.breakNext || forceBreak;
	ctx.breakNext = false;
	ctx.atStart = false;
	return new Paragraph({ ...opts, ...(pageBreakBefore ? { pageBreakBefore: true } : {}) });
}

const HEADING_LEVELS = [
	HeadingLevel.HEADING_1,
	HeadingLevel.HEADING_2,
	HeadingLevel.HEADING_3,
	HeadingLevel.HEADING_4,
	HeadingLevel.HEADING_5,
	HeadingLevel.HEADING_6,
] as const;

function heading(token: Tokens.Heading, ctx: Ctx): Block[] {
	const depth = Math.min(token.depth, 6);
	if (depth === 1) {
		ctx.refs = isReferencesTitle(token.text);
		if (ctx.mode === "front") {
			return [
				para(ctx, {
					alignment: AlignmentType.CENTER,
					spacing: { ...SPACING_1, after: ABNT_DOCX.lineSingle },
					children: inlineRuns(token.tokens, { bold: true, caps: true }),
				}),
			];
		}
		// Títulos pré-textuais não usam estilo de título (não entram no sumário) e abrem página.
		if (ctx.mode === "pre") {
			return [
				para(
					ctx,
					{
						alignment: AlignmentType.CENTER,
						keepNext: true,
						spacing: { ...SPACING_15, after: ABNT_DOCX.lineOneAndHalf },
						children: inlineRuns(token.tokens, { bold: true, caps: true }),
					},
					!ctx.atStart,
				),
			];
		}
		// Seção primária abre página (menos a primeira da parte, que já começa numa).
		return [
			para(
				ctx,
				{
					heading: HEADING_LEVELS[0],
					alignment: isUnnumberedTitle(token.text) ? AlignmentType.CENTER : AlignmentType.LEFT,
					keepNext: true,
					spacing: { ...SPACING_15, after: ABNT_DOCX.lineOneAndHalf },
					children: inlineRuns(token.tokens),
				},
				!ctx.atStart,
			),
		];
	}
	if (ctx.mode === "front") {
		return [para(ctx, { alignment: AlignmentType.CENTER, spacing: SPACING_1, children: inlineRuns(token.tokens, { bold: true }) })];
	}
	if (ctx.mode === "pre") {
		return [para(ctx, { alignment: AlignmentType.LEFT, keepNext: true, spacing: { ...SPACING_15, before: ABNT_DOCX.lineOneAndHalf, after: ABNT_DOCX.lineOneAndHalf }, children: inlineRuns(token.tokens, { bold: true }) })];
	}
	return [
		para(ctx, {
			heading: HEADING_LEVELS[depth - 1],
			alignment: AlignmentType.LEFT,
			keepNext: true,
			spacing: { ...SPACING_15, before: ABNT_DOCX.lineOneAndHalf, after: ABNT_DOCX.lineOneAndHalf },
			children: inlineRuns(token.tokens),
		}),
	];
}

function bodyParagraph(tokens: Token[] | undefined, text: string, ctx: Ctx): Paragraph {
	if (ctx.mode === "front") {
		return para(ctx, { alignment: AlignmentType.CENTER, spacing: { ...SPACING_1, after: 120 }, children: inlineRuns(tokens) });
	}
	if (ctx.refs) {
		return para(ctx, {
			alignment: AlignmentType.LEFT,
			spacing: { ...SPACING_1, after: ABNT_DOCX.lineSingle },
			children: inlineRuns(tokens),
		});
	}
	if (isCaptionText(plain(text))) {
		return para(ctx, {
			alignment: AlignmentType.LEFT,
			spacing: { ...SPACING_1, before: 120, after: ABNT_DOCX.lineSingle },
			children: inlineRuns(tokens, { size: ABNT_DOCX.smallSize }),
		});
	}
	if (ctx.mode === "pre") {
		return para(ctx, { alignment: AlignmentType.JUSTIFIED, spacing: { ...SPACING_1, after: 120 }, children: inlineRuns(tokens) });
	}
	return para(ctx, {
		alignment: AlignmentType.JUSTIFIED,
		indent: { firstLine: ABNT_DOCX.firstLine },
		spacing: SPACING_15,
		children: inlineRuns(tokens),
	});
}

function listBlocks(list: Tokens.List, level: number, ctx: Ctx): Block[] {
	const out: Block[] = [];
	for (const item of list.items) {
		const inline: Token[] = [];
		const nested: Token[] = [];
		for (const child of item.tokens) {
			if (child.type === "list") nested.push(child);
			else if (child.type === "text" || child.type === "paragraph") inline.push(...((child as Tokens.Text).tokens ?? [child]));
			else nested.push(child);
		}
		if (ctx.refs) {
			// Cada item é uma referência: sem marcador, simples, à esquerda, uma linha em branco entre elas.
			out.push(
				para(ctx, {
					alignment: AlignmentType.LEFT,
					spacing: { ...SPACING_1, after: ABNT_DOCX.lineSingle },
					children: inlineRuns(inline),
				}),
			);
		} else {
			out.push(
				para(ctx, {
					alignment: ctx.mode === "front" ? AlignmentType.LEFT : AlignmentType.JUSTIFIED,
					spacing: ctx.mode === "textual" ? SPACING_15 : SPACING_1,
					children: inlineRuns(inline),
					...(list.ordered
						? { numbering: { reference: "ordered", level: Math.min(level, 4) } }
						: { bullet: { level: Math.min(level, 4) } }),
				}),
			);
		}
		for (const child of nested) out.push(...blockToAbnt(child, ctx, level + 1));
	}
	return out;
}

const CELL_BORDER = { style: BorderStyle.SINGLE, size: 4, color: "000000" };
const BORDERS = { top: CELL_BORDER, bottom: CELL_BORDER, left: CELL_BORDER, right: CELL_BORDER };

function dataTable(token: Tokens.Table, ctx: Ctx): Block[] {
	const row = (cells: Tokens.TableCell[], header: boolean) =>
		new TableRow({
			tableHeader: header,
			cantSplit: true,
			children: cells.map(
				(cell) =>
					new TableCell({
						borders: BORDERS,
						margins: { top: 40, bottom: 40, left: 80, right: 80 },
						children: [
							new Paragraph({
								alignment: AlignmentType.LEFT,
								spacing: SPACING_1,
								children: inlineRuns(cell.tokens, { size: ABNT_DOCX.smallSize, ...(header ? { bold: true } : {}) }),
							}),
						],
					}),
			),
		});
	const blocks: Block[] = [];
	// Quebra pendente antes de uma tabela: um parágrafo mínimo a carrega.
	if (ctx.breakNext) blocks.push(para(ctx, { spacing: { ...SPACING_1, line: 20, lineRule: LineRuleType.EXACT } }));
	ctx.atStart = false;
	blocks.push(
		new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [row(token.header, true), ...token.rows.map((r) => row(r, false))] }),
		new Paragraph({ spacing: SPACING_1, children: [] }),
	);
	return blocks;
}

function quote(token: Tokens.Blockquote, ctx: Ctx): Block[] {
	const children = token.tokens.filter((child) => child.type !== "space");
	return children.flatMap((child, index) => {
		if (child.type !== "paragraph" && child.type !== "text") return blockToAbnt(child, ctx);
		const first = index === 0;
		const last = index === children.length - 1;
		return [
			para(ctx, {
				alignment: AlignmentType.JUSTIFIED,
				indent: { left: ctx.quoteIndent },
				spacing: { ...SPACING_1, before: first ? ABNT_DOCX.lineSingle : 0, after: last ? ABNT_DOCX.lineSingle : 120 },
				children: inlineRuns((child as Tokens.Paragraph).tokens, { size: ABNT_DOCX.smallSize }),
			}),
		];
	});
}

function blockToAbnt(token: Token, ctx: Ctx, level = 0): Block[] {
	switch (token.type) {
		case "heading":
			return heading(token as Tokens.Heading, ctx);
		case "paragraph": {
			const p = token as Tokens.Paragraph;
			return [bodyParagraph(p.tokens, p.text, ctx)];
		}
		case "text": {
			const t = token as Tokens.Text;
			return [bodyParagraph(t.tokens ?? [token], t.text, ctx)];
		}
		case "list":
			return listBlocks(token as Tokens.List, level, ctx);
		case "table":
			return dataTable(token as Tokens.Table, ctx);
		case "code":
			return (token as Tokens.Code).text.split("\n").map((line) =>
				para(ctx, { spacing: SPACING_1, children: [new TextRun({ text: line, font: "Consolas", size: ABNT_DOCX.smallSize })] }),
			);
		case "blockquote":
			return quote(token as Tokens.Blockquote, ctx);
		case "html":
			if ((token as Tokens.HTML).raw.trim() === ABNT_TOC) return tocBlocks(ctx);
			// Marcador de quebra de página; no início de uma página ele não faz nada (evita página em branco).
			if ((token as Tokens.HTML).raw.trim() === ABNT_PAGE_BREAK && !ctx.atStart) ctx.breakNext = true;
			return [];
		default:
			return [];
	}
}

function escapeXml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Sumário como campo TOC do Word sobre os estilos de título (1 a 4), já preenchido com as páginas medidas;
 * o Word o atualiza ao abrir (`updateFields`). Sem páginas medidas só o campo vazio de números.
 */
function tocBlocks(ctx: Ctx): Block[] {
	ctx.atStart = false;
	ctx.breakNext = false;
	const headings = ctx.toc?.headings ?? [];
	if (headings.length === 0) return [];
	const field = (type: string) => `<w:r><w:fldChar w:fldCharType="${type}"/></w:r>`;
	const begin = `${field("begin")}<w:r><w:instrText xml:space="preserve"> TOC \\o "1-4" \\h \\z</w:instrText></w:r>${field("separate")}`;
	const xml = headings.map((heading, index) => {
		const page = ctx.toc?.pages?.[index];
		const entry = `<w:r><w:t xml:space="preserve">${escapeXml(heading.text)}</w:t></w:r>${page === undefined ? "" : `<w:r><w:tab/></w:r><w:r><w:t>${page}</w:t></w:r>`}`;
		return `<w:p><w:pPr><w:pStyle w:val="TOC${Math.min(heading.depth, 4)}"/></w:pPr>${index === 0 ? begin : ""}${entry}</w:p>`;
	});
	// O campo fecha num parágrafo mínimo, como o Word faz.
	xml.push(`<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/><w:rPr><w:sz w:val="2"/></w:rPr></w:pPr>${field("end")}</w:p>`);
	// fromXmlString devolve um invólucro sem nome em volta do elemento `w:p`.
	return xml.map((item) => (ImportedXmlComponent.fromXmlString(item) as unknown as { root: unknown[] }).root[0] as Paragraph);
}

function newCtx(mode: Mode, quoteIndent: number = ABNT_DOCX.quoteIndent, toc?: Ctx["toc"]): Ctx {
	return { mode, atStart: true, breakNext: false, refs: false, quoteIndent, ...(toc ? { toc } : {}) };
}

function blocksOf(markdown: string, ctx: Ctx): Block[] {
	const tokens = new Lexer({ breaks: ctx.mode === "front" }).lex(markdown);
	return tokens.flatMap((token) => blockToAbnt(token, ctx));
}

/** Capa / folha de rosto: três zonas (topo, meio, rodapé) separadas por `---`, numa tabela de linhas altas sem bordas. */
function frontPage(markdown: string, quoteIndent: number): Block[] {
	const zones = splitFrontZones(markdown);
	const none = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
	const heights = [4200, 5200, 4200];
	const aligns = [VerticalAlign.TOP, VerticalAlign.CENTER, VerticalAlign.BOTTOM];
	const rows = [0, 1, 2].map((index) => {
		const zone = zones[index]!;
		const children = zone ? blocksOf(zone, newCtx("front", quoteIndent)) : [];
		return new TableRow({
			height: { value: heights[index]!, rule: HeightRule.ATLEAST },
			cantSplit: true,
			children: [
				new TableCell({
					verticalAlign: aligns[index]!,
					width: { size: TEXT_WIDTH, type: WidthType.DXA },
					borders: { top: none, bottom: none, left: none, right: none },
					children: children.length > 0 ? children : [new Paragraph({ children: [] })],
				}),
			],
		});
	});
	return [
		new Table({
			width: { size: TEXT_WIDTH, type: WidthType.DXA },
			columnWidths: [TEXT_WIDTH],
			layout: TableLayoutType.FIXED,
			borders: { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none },
			rows,
		}),
		// A seção precisa terminar em parágrafo; 1 pt para não empurrar uma página em branco.
		new Paragraph({ spacing: { before: 0, after: 0, line: 20, lineRule: LineRuleType.EXACT }, run: { size: 2 }, children: [] }),
	];
}

/**
 * Markdown para .docx em ABNT (NBR 14724): capa sem número, folha de rosto e pré-textual contadas mas sem número,
 * parte textual com número no canto superior direito. A numeração é do Word: a seção pré-textual recomeça em 1 e a
 * textual continua dela, qualquer que seja o tamanho do pré-textual. Sumário: campo TOC do Word (`tocPages` o preenche).
 */
export async function abntMarkdownToDocx(markdown: string, title?: string, opts: { font?: string; tocPages?: ReadonlyArray<number> } = {}): Promise<Uint8Array> {
	const font = opts.font ?? ABNT_DOCX.defaultFont;
	const parts = parseAbntMarkdown(markdown);
	const pageProps = { size: ABNT_DOCX.page, margin: ABNT_DOCX.margin };
	const sections: ISectionOptions[] = [];
	const toc = parts.hasToc ? { headings: tocHeadings(parts), ...(opts.tocPages ? { pages: opts.tocPages } : {}) } : undefined;

	if (parts.cover) sections.push({ properties: { page: pageProps }, children: frontPage(parts.cover, ABNT_DOCX.quoteIndent) });

	const preChildren: Block[] = [];
	if (parts.titlePage) preChildren.push(...frontPage(parts.titlePage, ABNT_DOCX.titlePageNoteIndent));
	if (parts.pretextual) {
		const ctx = newCtx("pre", ABNT_DOCX.quoteIndent, toc);
		// Depois da folha de rosto o conteúdo seguinte abre outra página.
		ctx.atStart = !parts.titlePage;
		ctx.breakNext = Boolean(parts.titlePage);
		preChildren.push(...blocksOf(parts.pretextual, ctx));
	}
	// A numeração recomeça em 1 na folha de rosto (a capa não é contada).
	if (preChildren.length > 0) {
		sections.push({ properties: { page: { ...pageProps, pageNumbers: { start: 1, formatType: NumberFormat.DECIMAL } } }, children: preChildren });
	}

	const textualChildren = parts.textual ? blocksOf(parts.textual, newCtx("textual", ABNT_DOCX.quoteIndent, toc)) : [];
	if (textualChildren.length > 0 || sections.length === 0) {
		sections.push({
			// Continua da seção anterior; sem pré-textual, a capa não deve ser contada.
			properties: { page: { ...pageProps, ...(preChildren.length === 0 ? { pageNumbers: { start: 1, formatType: NumberFormat.DECIMAL } } : {}) } },
			headers: {
				default: new Header({
					children: [
						new Paragraph({
							alignment: AlignmentType.RIGHT,
							children: [new TextRun({ children: [PageNumber.CURRENT], size: ABNT_DOCX.smallSize })],
						}),
					],
				}),
			},
			children: textualChildren.length > 0 ? textualChildren : [new Paragraph({ children: [] })],
		});
	}

	const headingStyle = (id: string, name: string, extra: { bold?: boolean; italics?: boolean; allCaps?: boolean }) => ({
		id,
		name,
		basedOn: "Normal",
		next: "Normal",
		quickFormat: true,
		run: { font, size: ABNT_DOCX.bodySize, color: "000000", bold: false, italics: false, ...extra },
	});
	const tocStyle = (level: number, extra: { bold?: boolean; italics?: boolean; allCaps?: boolean }) => ({
		id: `TOC${level}`,
		name: `toc ${level}`,
		basedOn: "Normal",
		next: "Normal",
		run: { font, size: ABNT_DOCX.bodySize, color: "000000", bold: false, italics: false, ...extra },
		paragraph: {
			tabStops: [{ type: TabStopType.RIGHT, position: TEXT_WIDTH, leader: LeaderType.DOT }],
			spacing: { line: ABNT_DOCX.lineSingle, lineRule: LineRuleType.AUTO, before: 0, after: 160 },
		},
	});
	const doc = new Document({
		title: title ?? undefined,
		creator: "Atlas",
		...(toc ? { features: { updateFields: true } } : {}),
		styles: {
			default: {
				document: {
					run: { font, size: ABNT_DOCX.bodySize },
					paragraph: { spacing: { line: ABNT_DOCX.lineOneAndHalf, lineRule: LineRuleType.AUTO } },
				},
			},
			paragraphStyles: [
				headingStyle("Heading1", "heading 1", { bold: true, allCaps: true }),
				headingStyle("Heading2", "heading 2", { bold: true }),
				headingStyle("Heading3", "heading 3", { bold: true, italics: true }),
				headingStyle("Heading4", "heading 4", { italics: true }),
				headingStyle("Heading5", "heading 5", { italics: true }),
				headingStyle("Heading6", "heading 6", { italics: true }),
				tocStyle(1, { bold: true, allCaps: true }),
				tocStyle(2, { bold: true }),
				tocStyle(3, { bold: true, italics: true }),
				tocStyle(4, { italics: true }),
			],
		},
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
		sections,
	});
	return new Uint8Array(await Packer.toBuffer(doc));
}
