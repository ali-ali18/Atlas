import { describe, expect, it } from "vitest";
import {
	FILE_MAX_CONTENT_CHARS,
	contentDisposition,
	fileCategory,
	formatFileSize,
	mimeForExtension,
	parseCreateFileArgs,
	parseFileArtifactMeta,
	resolveFileFormat,
	sanitizeFilename,
} from "./files.js";

describe("sanitizeFilename", () => {
	it("remove caminho e traversal", () => {
		expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
		expect(sanitizeFilename(String.raw`C:\Users\x\relatório.pdf`, "pdf")).toBe("relatório.pdf");
		expect(sanitizeFilename("a/b/../c.txt")).toBe("c.txt");
	});
	it("tira caracteres de controle e reservados", () => {
		expect(sanitizeFilename('re<la>t:"ó|r?io*.pdf', "pdf")).toBe("relatório.pdf");
		expect(sanitizeFilename("a\u0000b\n.txt")).toBe("ab.txt");
	});
	it("não deixa nome oculto, vazio ou reservado do Windows", () => {
		expect(sanitizeFilename("...", "txt")).toBe("arquivo.txt");
		expect(sanitizeFilename(".env", "txt")).toBe("env.txt");
		expect(sanitizeFilename("CON.txt")).toBe("_CON.txt");
	});
	it("força a extensão do formato", () => {
		expect(sanitizeFilename("plano.txt", "docx")).toBe("plano.docx");
		expect(sanitizeFilename("plano", "pdf")).toBe("plano.pdf");
		expect(sanitizeFilename("plano.PDF", "pdf")).toBe("plano.pdf");
		expect(sanitizeFilename("v1.2 notas", "md")).toBe("v1.2 notas.md");
	});
	it("limita a 120 caracteres mantendo a extensão", () => {
		const out = sanitizeFilename(`${"a".repeat(300)}.pdf`, "pdf");
		expect(out.length).toBe(120);
		expect(out.endsWith(".pdf")).toBe(true);
	});
});

describe("resolveFileFormat", () => {
	it("infere pela extensão", () => {
		expect(resolveFileFormat("a.pdf")).toEqual({ format: "pdf", ext: "pdf" });
		expect(resolveFileFormat("a.docx")).toEqual({ format: "docx", ext: "docx" });
		expect(resolveFileFormat("a.xlsx")).toEqual({ format: "xlsx", ext: "xlsx" });
		expect(resolveFileFormat("script.py")).toEqual({ format: "text", ext: "py" });
	});
	it("format explícito vence e aceita apelidos", () => {
		expect(resolveFileFormat("relatorio", "word")).toEqual({ format: "docx", ext: "docx" });
		expect(resolveFileFormat("dados", "excel")).toEqual({ format: "xlsx", ext: "xlsx" });
		expect(resolveFileFormat("nota.pdf", "txt")).toEqual({ format: "text", ext: "txt" });
	});
	it("rejeita sem extensão, executável e imagem", () => {
		expect(() => resolveFileFormat("semextensao")).toThrow(/extension/);
		expect(() => resolveFileFormat("setup.exe")).toThrow(/cannot be created/);
		expect(() => resolveFileFormat("foto.png")).toThrow(/Images/);
	});
});

describe("parseCreateFileArgs", () => {
	it("texto: guarda o content e sanitiza o nome", () => {
		const out = parseCreateFileArgs({ filename: "../x/script.py", content: "print(1)\n" });
		expect(out).toMatchObject({ filename: "script.py", format: "text", ext: "py", content: "print(1)\n" });
	});
	it("exige content, respeita o limite e recusa NUL", () => {
		expect(() => parseCreateFileArgs({ filename: "a.md" })).toThrow(/content is required/);
		expect(() => parseCreateFileArgs({ filename: "a.md", content: "x".repeat(FILE_MAX_CONTENT_CHARS + 1) })).toThrow(/too long/);
		expect(() => parseCreateFileArgs({ filename: "a.txt", content: "a\u0000b" })).toThrow(/binary/);
	});
	it("xlsx exige sheets válidas e normaliza nomes de aba", () => {
		expect(() => parseCreateFileArgs({ filename: "a.xlsx", content: "x" })).toThrow(/sheets/);
		const out = parseCreateFileArgs({
			filename: "a.xlsx",
			sheets: [
				{ name: "Preços: [2026]", columns: ["Loja", "Valor"], rows: [["ML", 10], ["Amazon", "=B2*2"], ["x", undefined]] },
				{ name: "Preços  2026", rows: [] },
			],
		});
		expect(out.sheets?.[0]?.name).toBe("Preços 2026");
		expect(out.sheets?.[1]?.name).not.toBe("Preços 2026");
		expect(out.sheets?.[0]?.rows[2]).toEqual(["x", null]);
	});
	it("pptx exige slides com título", () => {
		expect(() => parseCreateFileArgs({ filename: "a.pptx", slides: [{ bullets: ["x"] }] })).toThrow(/title/);
		const out = parseCreateFileArgs({ filename: "a.pptx", slides: [{ title: "Oi", bullets: ["a", " ", "b"] }] });
		expect(out.slides).toEqual([{ title: "Oi", bullets: ["a", "b"] }]);
	});
	it("css só vale para pdf", () => {
		expect(parseCreateFileArgs({ filename: "a.pdf", content: "# x", css: "h1{color:red}" }).css).toBe("h1{color:red}");
		expect(parseCreateFileArgs({ filename: "a.docx", content: "# x", css: "h1{}" }).css).toBeUndefined();
	});
});

describe("layout", () => {
	it("abnt só vale para docx e pdf; padrão e ausente não mudam o objeto", () => {
		expect(parseCreateFileArgs({ filename: "a.docx", content: "# x", layout: "abnt" }).layout).toBe("abnt");
		expect(parseCreateFileArgs({ filename: "a.pdf", content: "# x", layout: " ABNT " }).layout).toBe("abnt");
		expect(parseCreateFileArgs({ filename: "a.md", content: "# x", layout: "abnt" }).layout).toBeUndefined();
		expect(parseCreateFileArgs({ filename: "a.pdf", content: "# x", layout: "default" })).toEqual(parseCreateFileArgs({ filename: "a.pdf", content: "# x" }));
		expect("layout" in parseCreateFileArgs({ filename: "a.docx", content: "# x" })).toBe(false);
	});
	it("valor desconhecido volta erro acionável", () => {
		expect(() => parseCreateFileArgs({ filename: "a.docx", content: "# x", layout: "apa" })).toThrow(/layout must be one of: default, abnt/);
	});
});

describe("apresentação", () => {
	it("categoria, MIME e tamanho", () => {
		expect(fileCategory("a.pdf")).toBe("pdf");
		expect(fileCategory("a.csv")).toBe("sheet");
		expect(fileCategory("a.py")).toBe("code");
		expect(fileCategory("a.txt")).toBe("text");
		expect(mimeForExtension("docx")).toContain("wordprocessingml");
		expect(formatFileSize(12)).toBe("12 B");
		expect(formatFileSize(1536)).toBe("1,5 KB");
		expect(formatFileSize(5 * 1024 * 1024)).toBe("5 MB");
	});
	it("Content-Disposition com filename* UTF-8 e sem aspas soltas", () => {
		const header = contentDisposition('relatório "final".pdf', false);
		expect(header.startsWith("attachment;")).toBe(true);
		expect(header).toContain("filename*=UTF-8''relat%C3%B3rio%20final.pdf");
		expect(contentDisposition("a.pdf", true).startsWith("inline;")).toBe(true);
	});
	it("meta do artefato", () => {
		expect(parseFileArtifactMeta({ filename: "a.pdf", mime: "application/pdf", size: 10, version: 2, format: "pdf" })).toMatchObject({ version: 2, ext: "pdf" });
		expect(parseFileArtifactMeta({ mime: "x" })).toBeNull();
	});
});
