import { describe, expect, it } from "vitest";
import { fileCardKind, fileCardSubtitle } from "./file-card";

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

describe("fileCardSubtitle", () => {
	it("junta o tipo e o tamanho", () => {
		expect(fileCardSubtitle("a.pdf", "application/pdf", 1640)).toBe("Documento · 1,6 KB");
		expect(fileCardSubtitle("a.xlsx", "application/vnd.ms-excel", 2_100_000)).toBe("Planilha · 2 MB");
	});

	it("sem tamanho, só o tipo", () => {
		expect(fileCardSubtitle("a.pdf", "application/pdf")).toBe("Documento");
		expect(fileCardSubtitle("a.pdf", "application/pdf", -1)).toBe("Documento");
	});

	it("tipo desconhecido vira Arquivo", () => {
		expect(fileCardSubtitle("a.bin", "", 12)).toBe("Arquivo · 12 B");
	});
});
