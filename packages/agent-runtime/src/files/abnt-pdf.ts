import { Lexer, Marked, type Token, type Tokens } from "marked";
import sanitizeHtml from "sanitize-html";
import { ABNT_PAGE_BREAK, ABNT_TOC, isCaptionText, isReferencesTitle, isUnnumberedTitle, parseAbntMarkdown, splitFrontZones, tocHeadings, type TocHeading } from "./abnt.js";
import { measureHeadingPages } from "./abnt-toc.js";
import { SANITIZE, escapeHtml, safeCss, type PrintPdfOptions } from "./pdf.js";

const DEFAULT_FONT = "Times New Roman";

/**
 * CSS da NBR 14724 para o Chromium: A4 com margens 3/2/2/3 cm, texto 12 pt a 1,5, recuo de 1,25 cm.
 * Número de página no canto superior direito por caixa de margem (`@page tex`, Chromium 131+); a capa não é
 * contada (`@page :first` zera o contador) e a capa e o pré-textual não mostram número.
 */
export function abntCss(opts: { font?: string; cover?: boolean } = {}): string {
	const font = `"${(opts.font ?? DEFAULT_FONT).replace(/["\\<>{};]/g, "")}", "Liberation Serif", Tinos, Times, serif`;
	return `
@page { size: A4; margin: 3cm 2cm 2cm 3cm; }
${opts.cover ? "@page :first { counter-reset: page 0; }" : ""}
@page tex { @top-right { content: counter(page); font: 10pt ${font}; color: #000; text-align: right; vertical-align: top; padding-top: 1.9cm; } }
html { font-family: ${font}; }
body { font-size: 12pt; line-height: 1.5; color: #000; margin: 0; }
p { margin: 0; text-align: justify; text-indent: 1.25cm; orphans: 2; widows: 2; }
h1, h2, h3, h4, h5, h6 { font-size: 12pt; font-weight: bold; line-height: 1.5; margin: 18pt 0; text-align: left; break-after: avoid; }
h1 { text-transform: uppercase; margin-top: 0; }
h1.sem-numero { text-align: center; }
h1 { break-before: page; }
section > h1:first-child { break-before: auto; }
h3 { font-style: italic; } h4, h5, h6 { font-weight: normal; font-style: italic; }
.pb { height: 0; } .pb + * { break-before: page; }
ul, ol { margin: 0; padding-left: 1.25cm; } li { text-align: justify; } li p { text-indent: 0; }
table { border-collapse: collapse; width: 100%; margin: 6pt 0; font-size: 10pt; line-height: 1.15; break-inside: avoid; }
th, td { border: 1px solid #000; padding: 2pt 4pt; text-align: left; vertical-align: top; } th { font-weight: bold; }
td p, th p { text-indent: 0; text-align: left; }
p.cap { font-size: 10pt; line-height: 1.15; text-indent: 0; text-align: left; margin: 4pt 0 12pt; }
blockquote { margin: 12pt 0 12pt 4cm; font-size: 10pt; line-height: 1.15; text-align: justify; }
blockquote p { text-indent: 0; margin: 0 0 6pt; }
pre, code { font-family: Consolas, "Courier New", monospace; font-size: 10pt; } pre { white-space: pre-wrap; margin: 6pt 0; line-height: 1.15; }
img { max-width: 100%; }
.pre p { text-indent: 0; line-height: 1.15; margin: 0 0 6pt; }
.pre p.cap { margin: 4pt 0 12pt; }
.refs p, .refs li { text-align: left; text-indent: 0; line-height: 1.15; margin: 0 0 12pt; }
.refs ul, .refs ol { list-style: none; padding: 0; }
.front { text-align: center; break-after: page; }
.front p { text-indent: 0; text-align: center; line-height: 1.3; margin: 0 0 6pt; }
.front h1, .front h2, .front h3, .front h4 { text-align: center; font-style: normal; text-transform: uppercase; margin: 0 0 12pt; break-before: auto; }
.front blockquote { text-align: justify; }
.front blockquote p { text-align: justify; line-height: 1.15; }
.front.cover { page: cover; }
.front.rosto { page: pre; }
.front.rosto blockquote { margin-left: 8cm; }
.toc p { display: flex; align-items: baseline; text-indent: 0; text-align: left; line-height: 1.3; margin: 0 0 8pt; }
.toc .t { padding-right: 3pt; } .toc .n { padding-left: 3pt; }
.toc .d { flex: 1; border-bottom: 1.5px dotted #000; position: relative; top: -2pt; min-width: 12pt; }
.toc .l1 { font-weight: bold; text-transform: uppercase; } .toc .l2 { font-weight: bold; } .toc .l3 { font-weight: bold; font-style: italic; } .toc .l4 { font-style: italic; }
.zones { height: 245mm; display: grid; grid-template-rows: 1fr auto 1fr; }
.zones > .z3 { align-self: end; }
section.pre { page: pre; }
section.tex { page: tex; }
`;
}

function stripTags(html: string): string {
	return html.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&");
}

/** Markdown de uma parte para HTML; as seções "REFERÊNCIAS" saem num `div.refs` (espaçamento simples, à esquerda). */
function renderPart(markdown: string, breaks = false): string {
	const lexer = new Lexer({ breaks });
	const tokens = lexer.lex(markdown);
	const marked = new Marked({ breaks });
	const groups: Array<{ refs: boolean; tokens: Token[] }> = [{ refs: false, tokens: [] }];
	for (const token of tokens) {
		if (token.type === "heading" && (token as Tokens.Heading).depth === 1) {
			groups.push({ refs: isReferencesTitle((token as Tokens.Heading).text), tokens: [] });
		}
		groups[groups.length - 1]!.tokens.push(token);
	}
	const html = groups
		.filter((group) => group.tokens.length > 0)
		.map((group) => {
			const rendered = marked.parser(Object.assign(group.tokens, { links: tokens.links }) as Tokens.Generic[] & { links: typeof tokens.links });
			return group.refs ? `<div class="refs">${rendered}</div>` : rendered;
		})
		.join("");
	return html
		.replaceAll(ABNT_PAGE_BREAK, '<div class="pb"></div>')
		.replace(/<h1>([\s\S]*?)<\/h1>/g, (all, inner: string) => (isUnnumberedTitle(stripTags(inner)) ? `<h1 class="sem-numero">${inner}</h1>` : all))
		.replace(/<p>([\s\S]*?)<\/p>/g, (all, inner: string) => (isCaptionText(stripTags(inner)) ? `<p class="cap">${inner}</p>` : all));
}

function clean(html: string): string {
	return sanitizeHtml(html, SANITIZE);
}

function frontHtml(kind: "cover" | "rosto", markdown: string): string {
	const [top, middle, bottom] = splitFrontZones(markdown);
	const zone = (name: string, md: string) => `<div class="${name}">${md ? clean(renderPart(md, true)) : ""}</div>`;
	return `<div class="front ${kind}"><div class="zones">${zone("z1", top)}${zone("z2", middle)}${zone("z3", bottom)}</div></div>`;
}

/** Sumário (NBR 6027): títulos com o mesmo destaque do texto, linha pontilhada e número da página à direita. */
function tocHtml(headings: TocHeading[], pages: ReadonlyArray<number | string> | undefined): string {
	const rows = headings.map((heading, index) => {
		const page = pages?.[index];
		const number = page === undefined ? "" : `<span class="n">${escapeHtml(String(page))}</span>`;
		return `<p class="l${Math.min(heading.depth, 4)}"><span class="t">${escapeHtml(heading.text)}</span><span class="d"></span>${number}</p>`;
	});
	return `<div class="toc">${rows.join("")}</div>`;
}

const TOC_SLOT = '<div class="toc-slot"></div>';

export type AbntPdfOptions = { title?: string; css?: string; font?: string; tocPages?: ReadonlyArray<number | string> };

/** HTML completo (a página inteira) do PDF em ABNT; o Chromium só imprime. */
export function buildAbntPdfHtml(content: string, opts: AbntPdfOptions = {}): string {
	const parts = parseAbntMarkdown(content);
	const toc = parts.hasToc ? tocHtml(tocHeadings(parts), opts.tocPages) : "";
	const section = (markdown: string) => clean(renderPart(markdown).replaceAll(ABNT_TOC, TOC_SLOT)).replace(TOC_SLOT, toc);
	const body: string[] = [];
	if (parts.cover) body.push(frontHtml("cover", parts.cover));
	if (parts.titlePage) body.push(frontHtml("rosto", parts.titlePage));
	if (parts.pretextual) body.push(`<section class="pre">${section(parts.pretextual)}</section>`);
	if (parts.textual || body.length === 0) body.push(`<section class="tex">${section(parts.textual)}</section>`);
	return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(opts.title ?? "")}</title><style>${abntCss({ font: opts.font, cover: Boolean(parts.cover) })}${safeCss(opts.css)}</style></head><body>${body.join("")}</body></html>`;
}

type Print = (html: string, options?: PrintPdfOptions) => Promise<Uint8Array>;
type Measure = typeof measureHeadingPages;

/**
 * Primeira passada com o sumário em branco (números provisórios de dois dígitos, que ocupam o mesmo espaço) para
 * achar a página de cada título no contorno do PDF. `undefined` quando não há sumário ou não foi possível medir.
 */
export async function measureAbntPages(
	content: string,
	print: Print,
	opts: AbntPdfOptions = {},
	measure: Measure = measureHeadingPages,
): Promise<{ pdf: Uint8Array; pages: number[] | undefined } | undefined> {
	const parts = parseAbntMarkdown(content);
	if (!parts.hasToc) return undefined;
	const headings = tocHeadings(parts);
	const pdf = await print(buildAbntPdfHtml(content, { ...opts, tocPages: headings.map(() => "00") }), { outline: true });
	return { pdf, pages: headings.length > 0 ? await measure(pdf, headings, Boolean(parts.cover)) : [] };
}

/** PDF ABNT final; com sumário, imprime duas vezes: a segunda já com as páginas medidas na primeira. */
export async function renderAbntPdf(content: string, print: Print, opts: AbntPdfOptions = {}, measure: Measure = measureHeadingPages): Promise<Uint8Array> {
	const measured = await measureAbntPages(content, print, opts, measure);
	if (!measured) return print(buildAbntPdfHtml(content, opts));
	// Sem medida (Chromium sem contorno, título não achado) o sumário sai sem números em vez de números errados.
	return print(buildAbntPdfHtml(content, { ...opts, tocPages: measured.pages ?? [] }));
}
