import { describe, expect, it } from "vitest";
import { fileCardKind, fileCardSubtitle, fileCardTitle, splitFileName } from "./file-card";

describe("fileCardKind", () => {
	it("PDF é vermelho, docx azul, planilha verde, apresentação âmbar", () => {
		expect(fileCardKind("a.pdf")).toEqual({ tone: "destructive", glyph: "text" });
		expect(fileCardKind("a.docx")).toEqual({ tone: "info", glyph: "text" });
		expect(fileCardKind("a.xlsx")).toEqual({ tone: "success", glyph: "sheet" });
		expect(fileCardKind("a.csv")).toEqual({ tone: "success", glyph: "sheet" });
		expect(fileCardKind("a.pptx")).toEqual({ tone: "warning", glyph: "presentation" });
	});

	it("documento de texto (md, txt) usa a cor de documento, não a de arquivo qualquer", () => {
		expect(fileCardKind("notas.md", "text/markdown")).toEqual({ tone: "info", glyph: "text" });
		expect(fileCardKind("sem-extensao", "text/plain")).toEqual({ tone: "info", glyph: "text" });
	});

	it("tipo desconhecido fica neutro", () => {
		expect(fileCardKind("a.zip", "application/zip")).toEqual({ tone: "muted", glyph: "generic" });
		expect(fileCardKind("sem-extensao")).toEqual({ tone: "muted", glyph: "generic" });
	});
});

describe("splitFileName", () => {
	it("tira a extensão e a devolve em maiúsculas", () => {
		expect(splitFileName("exemplo-documento.pdf")).toEqual({ stem: "exemplo-documento", ext: "PDF" });
	});

	it("extensão dupla vale pela última parte", () => {
		expect(splitFileName("backup.tar.gz")).toEqual({ stem: "backup.tar", ext: "GZ" });
	});

	it("sem extensão válida o nome fica inteiro", () => {
		expect(splitFileName("sem-extensao")).toEqual({ stem: "sem-extensao", ext: "" });
		expect(splitFileName(".env")).toEqual({ stem: ".env", ext: "" });
		expect(splitFileName("termina.")).toEqual({ stem: "termina.", ext: "" });
		expect(splitFileName("Relatório v1.2 final")).toEqual({ stem: "Relatório v1.2 final", ext: "" });
		expect(splitFileName("a.extensaolonga")).toEqual({ stem: "a.extensaolonga", ext: "" });
	});
});

describe("fileCardTitle", () => {
	it("mostra o nome sem a extensão", () => {
		expect(fileCardTitle("Relatório de vendas.docx")).toBe("Relatório de vendas");
		expect(fileCardTitle("sem-extensao")).toBe("sem-extensao");
	});
});

describe("fileCardSubtitle", () => {
	it("extensão em maiúsculas e tamanho", () => {
		expect(fileCardSubtitle("a.pdf", "application/pdf", 1640)).toBe("PDF · 1,6 KB");
		expect(fileCardSubtitle("a.docx", "", 48200)).toBe("DOCX · 47,1 KB");
		expect(fileCardSubtitle("a.xlsx", "application/vnd.ms-excel", 2_100_000)).toBe("XLSX · 2 MB");
		expect(fileCardSubtitle("notas.md", "text/markdown", 3100)).toBe("MD · 3 KB");
	});

	it("sem tamanho, só a extensão", () => {
		expect(fileCardSubtitle("a.pdf", "application/pdf")).toBe("PDF");
		expect(fileCardSubtitle("a.pdf", "application/pdf", -1)).toBe("PDF");
	});

	it("sem extensão, usa o rótulo do tipo (pelo mime) e o tamanho", () => {
		expect(fileCardSubtitle("sem-extensao", "", 900)).toBe("Arquivo · 900 B");
		expect(fileCardSubtitle("sem-extensao", "application/pdf", 900)).toBe("Documento · 900 B");
	});
});
