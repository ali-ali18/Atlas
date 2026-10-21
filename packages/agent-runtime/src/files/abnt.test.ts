import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { parseCreateFileArgs } from "@workspace/shared";
import { ABNT_PAGE_BREAK, ABNT_TOC, isCaptionText, parseAbntMarkdown, splitFrontZones, tocHeadings } from "./abnt.js";
import { abntMarkdownToDocx } from "./abnt-docx.js";
import { buildAbntPdfHtml, measureAbntPages, renderAbntPdf } from "./abnt-pdf.js";
import { matchHeadingPages } from "./abnt-toc.js";
import { renderFile } from "./render.js";

// O docx empacota o jszip; resolve a partir dele para não depender de uma dependência direta nova.
const require = createRequire(import.meta.url);
type Zip = { loadAsync(data: Uint8Array): Promise<{ file(name: string): { async(type: "string"): Promise<string> } | null }> };
const JSZip = require(require.resolve("jszip", { paths: [require.resolve("docx")] })) as Zip;

async function docxParts(bytes: Uint8Array) {
	const zip = await JSZip.loadAsync(bytes);
	const read = async (name: string) => (await zip.file(name)?.async("string")) ?? "";
	const document = await read("word/document.xml");
	return {
		document,
		header: await read("word/header1.xml"),
		styles: await read("word/styles.xml"),
		sections: document.match(/<w:sectPr>[\s\S]*?<\/w:sectPr>/g) ?? [],
		paragraphs: document.match(/<w:p>[\s\S]*?<\/w:p>/g) ?? [],
	};
}

const SAMPLE = `<!-- capa -->
UNIVERSIDADE EXEMPLO

---

# Título do trabalho

---

Cidade Exemplo

2026
<!-- /capa -->

<!-- folha-de-rosto -->
Autora Exemplo

---

# Título do trabalho

> Trabalho apresentado como requisito parcial.

---

Cidade Exemplo

2026
<!-- /folha-de-rosto -->

# RESUMO

Texto do resumo.

# SUMÁRIO

1 INTRODUÇÃO

# 1 INTRODUÇÃO

Primeiro parágrafo do corpo do texto.

## 1.1 Contexto

### 1.1.1 Detalhe

Segundo parágrafo.

> Citação longa com mais de três linhas, recuada em quatro centímetros do texto (AUTOR, 2020, p. 1).

Fonte: elaboração própria.

# REFERÊNCIAS

AUTOR, Primeiro. **Livro**. Cidade: Editora, 2020.

- OUTRO, Segundo. Artigo. **Revista**, 2021.
`;

describe("parseAbntMarkdown", () => {
	it("separa capa, folha de rosto, pré-textual e textual", () => {
		const parts = parseAbntMarkdown(SAMPLE);
		expect(parts.cover).toContain("UNIVERSIDADE EXEMPLO");
		expect(parts.titlePage).toContain("Trabalho apresentado");
		expect(parts.pretextual).toMatch(/^# RESUMO[\s\S]*# SUMÁRIO\n\n<!--abnt-toc-->$/);
		expect(parts.pretextual).not.toContain("1 INTRODUÇÃO"); // o sumário escrito à mão foi descartado
		expect(parts.hasToc).toBe(true);
		expect(parts.textual.startsWith("# 1 INTRODUÇÃO")).toBe(true);
		expect(parts.textual).toContain("# REFERÊNCIAS");
		expect(parts.cover).not.toContain("<!--");
	});

	it("sem marcadores tudo é parte textual; `<!-- textual -->` força o começo", () => {
		const plain = parseAbntMarkdown("Texto solto.\n\n## Seção\n\nMais texto.");
		expect(plain.cover).toBeUndefined();
		expect(plain.pretextual).toBe("");
		expect(plain.textual).toContain("Texto solto.");
		const marked = parseAbntMarkdown("# RESUMO\n\nAbc\n\n<!-- textual -->\n\n# Outro título\n\nCorpo");
		expect(marked.pretextual).toBe("# RESUMO\n\nAbc");
		expect(marked.textual).toBe("# Outro título\n\nCorpo");
	});

	it("aceita `\\pagebreak` e `<!-- pagebreak -->` e ignora marcadores dentro de código", () => {
		const parts = parseAbntMarkdown("1\n\n\\pagebreak\n\n2\n\n<!-- pagebreak -->\n\n```\n\\pagebreak\n<!-- capa -->\n```");
		expect(parts.textual.split(ABNT_PAGE_BREAK)).toHaveLength(3);
		expect(parts.textual).toContain("```\n\\pagebreak\n<!-- capa -->\n```");
		expect(parts.cover).toBeUndefined();
	});

	it("sumário: marcador ou `# SUMÁRIO` (o corpo escrito à mão é descartado); sem pedido, nada é gerado", () => {
		const viaMarker = parseAbntMarkdown("# RESUMO\n\nx\n\n<!-- sumario -->\n\n# 1 INTRODUÇÃO\n\ny");
		expect(viaMarker.hasToc).toBe(true);
		expect(viaMarker.pretextual).toMatch(/^# RESUMO\n\nx\n+# SUMÁRIO\n\n<!--abnt-toc-->$/);
		const viaHeading = parseAbntMarkdown("# SUMÁRIO\n\nlinha antiga\n\n- outra\n\n# 1 INTRODUÇÃO\n\ny");
		expect(viaHeading.pretextual).toBe(`# SUMÁRIO\n\n${ABNT_TOC}`);
		expect(viaHeading.textual).toBe("# 1 INTRODUÇÃO\n\ny");
		const none = parseAbntMarkdown("# RESUMO\n\nx\n\n# 1 INTRODUÇÃO\n\ny");
		expect(none.hasToc).toBe(false);
		expect(none.pretextual).not.toContain(ABNT_TOC);
	});

	it("títulos do sumário vêm da parte textual até o quarto nível, com texto puro", () => {
		const parts = parseAbntMarkdown("# 1 INTRODUÇÃO\n\n## 1.1 Um **negrito**\n\n##### 1.1.1.1.1 fundo\n\n```\n# nao\n```\n\n# REFERÊNCIAS");
		expect(tocHeadings(parts)).toEqual([
			{ depth: 1, text: "1 INTRODUÇÃO" },
			{ depth: 2, text: "1.1 Um negrito" },
			{ depth: 1, text: "REFERÊNCIAS" },
		]);
	});

	it("divide a capa em topo, meio e rodapé", () => {
		expect(splitFrontZones("a\n\n---\n\nb\n\n---\n\nc\n\nd")).toEqual(["a", "b", "c\n\nd"]);
		expect(splitFrontZones("só topo")).toEqual(["só topo", "", ""]);
	});

	it("reconhece legendas e fontes", () => {
		expect(isCaptionText("Fonte: IBGE (2020)")).toBe(true);
		expect(isCaptionText("Tabela 1 – Frequência")).toBe(true);
		expect(isCaptionText("A tabela 1 mostra")).toBe(false);
	});
});

describe("abntMarkdownToDocx", () => {
	it("margens, fonte, espaçamento, recuo e citação em twips", async () => {
		const { document, styles, sections, paragraphs } = await docxParts(await abntMarkdownToDocx(SAMPLE, "Título"));
		for (const section of sections) {
			expect(section).toContain('w:top="1701"');
			expect(section).toContain('w:left="1701"');
			expect(section).toContain('w:bottom="1134"');
			expect(section).toContain('w:right="1134"');
			expect(section).toContain('w:w="11906"');
		}
		expect(styles).toContain('w:ascii="Times New Roman"');
		expect(styles).toMatch(/<w:docDefaults>[\s\S]*<w:sz w:val="24"\/>/);
		expect(styles).toMatch(/<w:spacing w:line="360"/);
		// corpo: 1,5, justificado, recuo de 1,25 cm
		const body = paragraphs.find((p) => p.includes("Primeiro parágrafo"))!;
		expect(body).toContain('<w:ind w:firstLine="709"/>');
		expect(body).toContain('w:line="360"');
		expect(body).toContain('<w:jc w:val="both"/>');
		// citação: 4 cm, 10 pt, espaçamento simples
		const quote = paragraphs.find((p) => p.includes("Citação longa"))!;
		expect(quote).toContain('<w:ind w:left="2268"/>');
		expect(quote).toContain('<w:sz w:val="20"/>');
		expect(quote).toContain('w:line="240"');
		expect(quote).toContain('<w:jc w:val="both"/>');
		// natureza do trabalho na folha de rosto: 8 cm
		expect(document).toContain('w:left="4536"');
		// título primário em negrito e caixa alta; secundário em negrito; terciário em negrito e itálico
		expect(styles).toMatch(/w:styleId="Heading1"[\s\S]*?<w:b\/>[\s\S]*?<w:caps\/>[\s\S]*?<\/w:style>/);
		expect(styles).toMatch(/w:styleId="Heading3"[\s\S]*?<w:b\/>[\s\S]*?<w:i\/>[\s\S]*?<\/w:style>/);
	});

	it("referências à esquerda, espaçamento simples, sem recuo e uma linha entre entradas", async () => {
		const { paragraphs } = await docxParts(await abntMarkdownToDocx(SAMPLE));
		const refs = paragraphs.filter((p) => /AUTOR, Primeiro|OUTRO, Segundo/.test(p));
		expect(refs).toHaveLength(2);
		for (const p of refs) {
			expect(p).toContain('<w:jc w:val="left"/>');
			expect(p).toContain('w:line="240"');
			expect(p).toContain('w:after="240"');
			expect(p).not.toContain("w:firstLine");
			expect(p).not.toContain("<w:numPr>");
		}
		// o corpo continua justificado
		const body = paragraphs.find((p) => p.includes("Primeiro parágrafo"))!;
		expect(body).toContain('<w:jc w:val="both"/>');
	});

	it("seções: capa sem número; pré-textual recomeça em 1 sem cabeçalho; textual com PAGE continuando a contagem do Word", async () => {
		const { sections, header } = await docxParts(await abntMarkdownToDocx(SAMPLE));
		expect(sections).toHaveLength(3);
		expect(sections[0]).not.toContain("headerReference");
		expect(sections[0]).not.toContain("w:start");
		expect(sections[1]).not.toContain("headerReference");
		expect(sections[1]).toContain('<w:pgNumType w:start="1" w:fmt="decimal"/>');
		expect(sections[2]).toContain("headerReference");
		expect(sections[2]).toContain("<w:pgNumType/>"); // sem início explícito: continua da seção anterior
		expect(header).toContain("PAGE");
		expect(header).toContain('<w:jc w:val="right"/>');
		expect(header).toContain('<w:sz w:val="20"/>');
	});

	it("seções primárias abrem página (menos a primeira da parte) e títulos sem número ficam centralizados", async () => {
		const { paragraphs } = await docxParts(await abntMarkdownToDocx(SAMPLE));
		const heading = (text: string) => paragraphs.find((p) => p.includes(`>${text}<`) && !p.includes("TOC"))!;
		expect(heading("RESUMO")).toContain("<w:pageBreakBefore/>"); // depois da folha de rosto
		expect(heading("RESUMO")).toContain('<w:jc w:val="center"/>');
		// títulos pré-textuais não usam estilo de título: ficam fora do sumário do Word
		expect(heading("RESUMO")).not.toContain("Heading");
		expect(heading("SUMÁRIO")).not.toContain("Heading");
		expect(heading("1 INTRODUÇÃO")).toContain("Heading1");
		expect(heading("SUMÁRIO")).toContain("<w:pageBreakBefore/>");
		expect(heading("1 INTRODUÇÃO")).not.toContain("<w:pageBreakBefore/>"); // já abre a seção textual
		expect(heading("1 INTRODUÇÃO")).toContain('<w:jc w:val="left"/>');
		expect(heading("REFERÊNCIAS")).toContain("<w:pageBreakBefore/>");
		expect(heading("REFERÊNCIAS")).toContain('<w:jc w:val="center"/>');
	});

	it("sem marcadores: uma seção só, numerada a partir de 1", async () => {
		const { sections, header } = await docxParts(await abntMarkdownToDocx("# 1 INTRODUÇÃO\n\nTexto.\n\n# 2 MÉTODO\n\nMais."));
		expect(sections).toHaveLength(1);
		expect(sections[0]).toContain('w:start="1"');
		expect(header).toContain("PAGE");
	});

	it("quebra de página explícita vira pageBreakBefore no próximo parágrafo", async () => {
		const { paragraphs } = await docxParts(await abntMarkdownToDocx("Antes.\n\n\\pagebreak\n\nDepois."));
		expect(paragraphs.find((p) => p.includes("Depois."))).toContain("<w:pageBreakBefore/>");
		expect(paragraphs.find((p) => p.includes("Antes."))).not.toContain("<w:pageBreakBefore/>");
	});
});

describe("buildAbntPdfHtml", () => {
	const html = buildAbntPdfHtml(SAMPLE, { title: "Título" });

	it("CSS com A4, margens, fonte, recuo, citação e número de página só na parte textual", () => {
		expect(html).toContain("@page { size: A4; margin: 3cm 2cm 2cm 3cm; }");
		expect(html).toContain("@page :first { counter-reset: page 0; }");
		expect(html).toMatch(/@page tex \{ @top-right \{ content: counter\(page\); font: 10pt "Times New Roman"/);
		expect(html).not.toMatch(/@page (pre|cover) \{ @top/);
		expect(html).toContain('font-family: "Times New Roman"');
		expect(html).toContain("font-size: 12pt; line-height: 1.5");
		expect(html).toContain("text-indent: 1.25cm");
		expect(html).toContain("blockquote { margin: 12pt 0 12pt 4cm; font-size: 10pt; line-height: 1.15; text-align: justify; }");
		expect(html).toContain(".refs p, .refs li { text-align: left; text-indent: 0; line-height: 1.15; margin: 0 0 12pt; }");
	});

	it("estrutura: capa, folha de rosto, pré-textual e textual; referências embrulhadas", () => {
		const order = ['class="front cover"', 'class="front rosto"', 'section class="pre"', 'section class="tex"'].map((s) => html.indexOf(s));
		expect(order.every((n) => n >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
		expect(html).toContain('<div class="refs"><h1 class="sem-numero">REFERÊNCIAS</h1>');
		expect(html).toContain('<h1 class="sem-numero">RESUMO</h1>');
		expect(html).toContain("<h1>1 INTRODUÇÃO</h1>");
		expect(html).toContain('<p class="cap">Fonte: elaboração própria.</p>');
		expect(html).not.toContain("<!--");
		expect(html).not.toContain("<script");
	});

	it("sem capa não zera o contador; a fonte é configurável", () => {
		const plain = buildAbntPdfHtml("# 1 INTRODUÇÃO\n\nTexto.", { font: "Arial" });
		expect(plain).not.toContain("counter-reset");
		expect(plain).toContain('font-family: "Arial"');
		expect(plain).not.toContain('class="front');
	});

	it("quebra de página explícita e css extra do modelo (sanitizado)", () => {
		const out = buildAbntPdfHtml("a\n\n\\pagebreak\n\nb", { css: "p { color: red } @import url(http://x/y.css);" });
		expect(out).toContain('<div class="pb"></div>');
		expect(out).toContain("color: red");
		expect(out).not.toContain("@import");
	});
});

describe("sumário automático", () => {
	it("docx: campo TOC do Word nos estilos de título 1-4, preenchido com as páginas e com updateFields", async () => {
		const bytes = await abntMarkdownToDocx(SAMPLE, "T", { tocPages: [1, 1, 2, 3] });
		const { paragraphs, document, styles } = await docxParts(bytes);
		const entries = paragraphs.filter((p) => p.includes('w:val="TOC'));
		expect(entries).toHaveLength(4); // os quatro títulos da parte textual do SAMPLE
		expect(document).toContain('w:fldCharType="begin"');
		expect(document).toContain(' TOC \\o &quot;1-4&quot; \\h \\z');
		expect(document).toContain('w:fldCharType="separate"');
		expect(document).toContain('w:fldCharType="end"');
		expect(entries[0]).toContain("1 INTRODUÇÃO");
		expect(entries[0]).toContain("<w:tab/>");
		expect(entries[0]).toContain("<w:t>1</w:t>");
		expect(entries[3]).toContain("REFERÊNCIAS");
		expect(entries[3]).toContain("<w:t>3</w:t>");
		expect(entries[2]).toContain('w:val="TOC3"');
		expect(styles).toContain('w:styleId="TOC1"');
		expect(styles).toMatch(/w:styleId="TOC1"[\s\S]*?<w:tab w:val="right" w:pos="9071" w:leader="dot"\/>/);
		const zip = await JSZip.loadAsync(bytes);
		expect(await zip.file("word/settings.xml")!.async("string")).toContain("<w:updateFields/>");
	});

	it("docx sem páginas medidas: campo sem números e sem pedido de sumário nada é gerado", async () => {
		const bare = await docxParts(await abntMarkdownToDocx(SAMPLE));
		expect(bare.paragraphs.filter((p) => p.includes('w:val="TOC'))[0]).not.toContain("<w:tab/>");
		const none = await docxParts(await abntMarkdownToDocx("# 1 INTRODUÇÃO\n\nx"));
		expect(none.document).not.toContain("fldCharType");
		const zip = await JSZip.loadAsync(await abntMarkdownToDocx("# 1 INTRODUÇÃO\n\nx"));
		expect(await zip.file("word/settings.xml")!.async("string")).not.toContain("updateFields");
	});

	it("pdf: entradas com o mesmo destaque do título, linha pontilhada e página à direita", () => {
		const html = buildAbntPdfHtml(SAMPLE, { tocPages: [1, 1, 2, 3] });
		expect(html).toContain('<p class="l1"><span class="t">1 INTRODUÇÃO</span><span class="d"></span><span class="n">1</span></p>');
		expect(html).toContain('<p class="l3"><span class="t">1.1.1 Detalhe</span><span class="d"></span><span class="n">2</span></p>');
		expect(html).toContain('<p class="l1"><span class="t">REFERÊNCIAS</span><span class="d"></span><span class="n">3</span></p>');
		expect(html).toContain(".toc .d { flex: 1; border-bottom: 1.5px dotted #000;");
		expect(html).not.toContain("toc-slot");
		expect(html).not.toContain("<!--");
	});

	it("matchHeadingPages: página física menos a capa, na ordem, ignorando títulos pré-textuais", () => {
		const outline = [
			{ title: "Título do trabalho", page: 1 },
			{ title: "Resumo", page: 3 },
			{ title: "1 introdução", page: 6 },
			{ title: "1.1 Contexto", page: 6 },
			{ title: "REFERÊNCIAS", page: 9 },
		];
		const headings = [
			{ depth: 1, text: "1 INTRODUÇÃO" },
			{ depth: 2, text: "1.1  Contexto" },
			{ depth: 1, text: "REFERÊNCIAS" },
		];
		expect(matchHeadingPages(outline, headings, 1)).toEqual([5, 5, 8]);
		expect(matchHeadingPages(outline, headings, 0)).toEqual([6, 6, 9]);
		expect(matchHeadingPages(outline, [{ depth: 1, text: "Inexistente" }], 1)).toBeUndefined();
	});

	it("pdf em duas passadas: mede na primeira (com contorno) e imprime a segunda com os números", async () => {
		const print = vi.fn(async (_html: string, _options?: { outline?: boolean }) => new TextEncoder().encode("%PDF-1.4 fake"));
		const measure = vi.fn(async () => [5, 5, 6, 7]);
		await renderAbntPdf(SAMPLE, print, {}, measure);
		expect(print).toHaveBeenCalledTimes(2);
		expect(print.mock.calls[0]![1]).toEqual({ outline: true });
		expect(print.mock.calls[0]![0]).toContain('<span class="n">00</span>');
		expect(print.mock.calls[1]![1]).toBeUndefined();
		expect(print.mock.calls[1]![0]).toContain('<span class="t">REFERÊNCIAS</span><span class="d"></span><span class="n">7</span>');
		expect(measure).toHaveBeenCalledWith(expect.anything(), expect.arrayContaining([{ depth: 1, text: "1 INTRODUÇÃO" }]), true);
	});

	it("sem medida possível o sumário sai sem números; sem sumário é uma passada só", async () => {
		const print = vi.fn(async (_html: string) => new TextEncoder().encode("%PDF-1.4 fake"));
		await renderAbntPdf(SAMPLE, print, {}, async () => undefined);
		expect(print).toHaveBeenCalledTimes(2);
		expect(print.mock.calls[1]![0]).not.toContain('class="n"');
		print.mockClear();
		await renderAbntPdf("# 1 INTRODUÇÃO\n\nx", print);
		expect(print).toHaveBeenCalledTimes(1);
		expect(await measureAbntPages("# 1 INTRODUÇÃO\n\nx", print)).toBeUndefined();
	});
});

describe("renderFile com layout abnt", () => {
	it("pdf usa o HTML ABNT e docx o gerador ABNT; o padrão não muda", async () => {
		const printPdf = vi.fn(async () => new TextEncoder().encode("%PDF-1.4 fake"));
		await renderFile(parseCreateFileArgs({ filename: "t.pdf", content: SAMPLE, layout: "abnt" }), { printPdf });
		expect((printPdf.mock.calls[0] as unknown as [string])[0]).toContain("@page tex");
		await renderFile(parseCreateFileArgs({ filename: "t.pdf", content: "# Oi" }), { printPdf });
		expect((printPdf.mock.calls.at(-1) as unknown as [string])[0]).not.toContain("@page tex");
		const abnt = await docxParts((await renderFile(parseCreateFileArgs({ filename: "t.docx", content: SAMPLE, layout: "abnt" }))).bytes);
		expect(abnt.sections).toHaveLength(3);
		const normal = await docxParts((await renderFile(parseCreateFileArgs({ filename: "t.docx", content: SAMPLE }))).bytes);
		expect(normal.sections).toHaveLength(1);
		expect(normal.header).toBe("");
	});
});
