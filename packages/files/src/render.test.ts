import ExcelJS from "exceljs";
import mammoth from "mammoth";
import { describe, expect, it, vi } from "vitest";
import { parseCreateFileArgs } from "@workspace/shared";
import { renderFile } from "./render.js";

const MARKDOWN = `# Resumo do PVU

Texto com **negrito** e *itálico*.

## Itens

- um
- dois

| Item | Valor |
|---|---|
| Alpha | 10 |
| Beta | 20 |
`;

describe("renderFile", () => {
	it("texto e código saem iguais ao conteúdo", async () => {
		const code = "print('oi')\nfor i in range(3):\n    print(i)\n";
		const out = await renderFile(parseCreateFileArgs({ filename: "rename.py", content: code }));
		expect(new TextDecoder().decode(out.bytes)).toBe(code);
		expect(out.mime).toContain("python");
	});

	it("docx abre no mammoth com títulos e tabela", async () => {
		const input = parseCreateFileArgs({ filename: "pvu.docx", content: MARKDOWN, title: "PVU" });
		const out = await renderFile(input);
		const { value: html } = await mammoth.convertToHtml({ buffer: Buffer.from(out.bytes) });
		expect(html).toContain("Resumo do PVU");
		expect(html).toContain("Itens");
		expect(html).toContain("<table>");
		expect(html).toContain("Alpha");
		expect(html).toContain("<strong>negrito</strong>");
		expect(html).toContain("<li>");
	});

	it("xlsx lido de volta tem linhas e fórmula", async () => {
		const input = parseCreateFileArgs({
			filename: "precos.xlsx",
			sheets: [{ name: "Preços", columns: ["Item", "Qtd", "Total"], rows: [["A", 2, "=B2*10"], ["B", 3, null]] }],
		});
		const out = await renderFile(input);
		const wb = new ExcelJS.Workbook();
		await wb.xlsx.load(Buffer.from(out.bytes) as unknown as ArrayBuffer);
		const ws = wb.getWorksheet("Preços")!;
		expect(ws.getRow(1).values).toEqual([undefined, "Item", "Qtd", "Total"]);
		expect(ws.getCell("A2").value).toBe("A");
		expect(ws.getCell("B3").value).toBe(3);
		expect(ws.getCell("C2").value).toMatchObject({ formula: "B2*10" });
		expect(ws.getRow(1).font?.bold).toBe(true);
	});

	it("pptx gera um zip válido", async () => {
		const out = await renderFile(
			parseCreateFileArgs({ filename: "deck.pptx", slides: [{ title: "Oi", bullets: ["a", "b"] }] }),
		);
		expect(Buffer.from(out.bytes).subarray(0, 2).toString()).toBe("PK");
	});

	it("pdf entrega ao printPdf um HTML com o conteúdo, sem script", async () => {
		const printPdf = vi.fn(async () => new TextEncoder().encode("%PDF-1.4 fake"));
		const input = parseCreateFileArgs({
			filename: "pvu.pdf",
			content: `${MARKDOWN}\n<script>alert(1)</script>`,
			title: "Meu PVU",
			css: "h1 { color: red } @import url(http://x/y.css);",
		});
		const out = await renderFile(input, { printPdf });
		expect(out.mime).toBe("application/pdf");
		const html = (printPdf.mock.calls[0] as unknown as [string])[0];
		expect(html).toContain("Resumo do PVU");
		expect(html).toContain("<table>");
		expect(html).toContain("Meu PVU");
		expect(html).toContain("color: red");
		expect(html).not.toContain("<script");
		expect(html).not.toContain("@import");
	});

	it("pdf sem impressora configurada falha com erro acionável", async () => {
		await expect(renderFile(parseCreateFileArgs({ filename: "a.pdf", content: "x" }))).rejects.toThrow(/PDF generation/);
	});

	it("pdf não duplica título quando o conteúdo começa com mesmo h1", async () => {
		const printPdf = vi.fn(async () => new TextEncoder().encode("%PDF-1.4 fake"));
		const input = parseCreateFileArgs({
			filename: "report.pdf",
			content: "# Relatório Mensal\n\nConteúdo do relatório aqui...",
			title: "Relatório Mensal",
		});
		const out = await renderFile(input, { printPdf });
		const html = (printPdf.mock.calls[0] as unknown as [string])[0];
		// Count h1 tags: should be exactly 1 (from content, not duplicated from title)
		const h1Count = (html.match(/<h1[^>]*>/gi) || []).length;
		expect(h1Count).toBe(1);
		expect(html).toContain("Relatório Mensal");
	});

	it("pdf adiciona título quando conteúdo tem h1 diferente", async () => {
		const printPdf = vi.fn(async () => new TextEncoder().encode("%PDF-1.4 fake"));
		const input = parseCreateFileArgs({
			filename: "report.pdf",
			content: "# Seção Principal\n\nConteúdo aqui...",
			title: "Relatório Mensal",
		});
		const out = await renderFile(input, { printPdf });
		const html = (printPdf.mock.calls[0] as unknown as [string])[0];
		// Should have 2 h1 tags: one from title, one from content
		const h1Count = (html.match(/<h1[^>]*>/gi) || []).length;
		expect(h1Count).toBe(2);
		expect(html).toContain("Relatório Mensal");
		expect(html).toContain("Seção Principal");
	});

	it("pdf adiciona título quando conteúdo não tem h1", async () => {
		const printPdf = vi.fn(async () => new TextEncoder().encode("%PDF-1.4 fake"));
		const input = parseCreateFileArgs({
			filename: "report.pdf",
			content: "## Introdução\n\nTexto simples sem h1...",
			title: "Meu Relatório",
		});
		const out = await renderFile(input, { printPdf });
		const html = (printPdf.mock.calls[0] as unknown as [string])[0];
		// Should have 1 h1 tag (from title)
		const h1Count = (html.match(/<h1[^>]*>/gi) || []).length;
		expect(h1Count).toBe(1);
		expect(html).toContain("Meu Relatório");
	});
});
